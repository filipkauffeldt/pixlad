import type { Page } from '@playwright/test';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerRemove, dropFiles, launch, type Launched, pickTool } from '../e2e/app';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { packagedAppImage, packagedExecutable } from './executable';

let running: Launched | undefined;
afterEach(async () => {
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

async function dragAcrossPhoto(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await page.locator('[data-testid="photo"]').boundingBox();
  if (!box) throw new Error('no photo on screen');
  const at = (p: [number, number]): [number, number] => [
    box.x + p[0] * box.width,
    box.y + p[1] * box.height,
  ];
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at(to), { steps: 8 });
  await page.mouse.up();
}

describe('the packaged app', () => {
  it('opens a photo, exports it, detects faces and shows the licences', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pixlad-package-'));
    const file = join(dir, 'photo.jpg');
    await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));

    running = await launch({ executablePath: packagedExecutable() });
    const { app, page } = running;
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);

    // macOS takes the icon from the bundle instead.
    const iconComesFromResources = process.platform !== 'darwin';
    if (iconComesFromResources) {
      const iconSize = await app.evaluate(() => {
        const { statSync } = process.getBuiltinModule('node:fs');
        const { join } = process.getBuiltinModule('node:path');
        return statSync(join(process.resourcesPath, 'icon.png')).size;
      });
      expect(iconSize).toBeGreaterThan(0);
    }

    await dropFiles(page, [file]);
    await page.waitForSelector('[data-testid="photo"]', { timeout: 30_000 });
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
      return !!img && img.complete && img.naturalWidth > 0;
    });

    await pickTool(page, 'rect');
    await dragAcrossPhoto(page, [0.3, 0.2], [0.7, 0.6]);
    await page.waitForSelector('[data-testid="mosaic-patch"]', { timeout: 30_000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 60_000 });
    await answerRemove(page, 'keep');
    expect((await readdir(dir)).sort()).toEqual(['photo.jpg', 'photo_edit.jpg']);

    await pickTool(page, 'faces');
    await dragAcrossPhoto(page, [0.02, 0.02], [0.3, 0.3]);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="detect-label"]')?.textContent === 'No faces found' ||
        document.querySelector('[data-testid="notice"]') !== null,
      undefined,
      { timeout: 60_000 },
    );
    const texts = await page.locator('[data-testid="notice"]').allTextContents();
    expect(texts.join('\n')).not.toContain('Face detection failed');
    expect(await page.locator('[data-testid="detect-label"]').innerText()).toBe('No faces found');

    await page.click('[data-testid="settings"]');
    await page.click('[data-testid="open-about"]');
    const about = page.locator('[data-testid="about"]');
    await about.waitFor();
    // A local build without PIXLAD_VERSION reports the package.json placeholder, shown as "dev".
    const reported = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    const version = reported === '0.0.0-dev' ? 'dev' : reported;
    await page.getByText(`Version ${version}`, { exact: true }).waitFor();
    await page.click('[data-testid="open-licences"]');
    expect(await about.locator('[data-testid="about-notices"] .noticeRow').count()).toBeGreaterThan(
      10,
    );
    await page.click('[data-testid="about-gpl"]');
    expect(await about.locator('.licenseText').innerText()).toContain('GNU GENERAL PUBLIC LICENSE');
    await page.locator('.noticeRow', { hasText: /^react \d/ }).click();
    expect(await about.locator('.licenseText').innerText()).toContain(
      'Permission is hereby granted',
    );
    await page.locator('.noticeRow', { hasText: 'Electron and Chromium' }).click();
    await about.getByRole('button', { name: 'Open Chromium licences' }).waitFor();
  });

  it.runIf(process.platform === 'linux')('starts from the AppImage', async () => {
    running = await launch({
      executablePath: packagedAppImage(),
      // The runner has no FUSE, so the runtime unpacks itself and runs from there.
      env: { APPIMAGE_EXTRACT_AND_RUN: '1' },
    });
    const { app } = running;
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
    expect(await app.evaluate(() => process.env['APPIMAGE'])).toMatch(/\.AppImage$/);
  });
});
