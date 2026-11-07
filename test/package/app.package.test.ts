import type { Page } from '@playwright/test';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dropFiles, launch, type Launched } from '../e2e/app';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { packagedExecutable } from './executable';

let running: Launched | undefined;
afterEach(async () => {
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

/** A real-mouse drag between two points given as fractions of the photo. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
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
    const dir = await mkdtemp(join(tmpdir(), 'mr-package-'));
    const file = join(dir, 'photo.jpg');
    await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));

    running = await launch({ executablePath: packagedExecutable() });
    const { app, page } = running;
    // The app is the packaged one, not the source tree.
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);

    // The window icon comes from the resources folder on Windows and Linux. macOS reads the
    // bundle's own icon instead.
    if (process.platform !== 'darwin') {
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

    // Rectangle and export: this runs the photo and export workers from the package.
    await page.click('[data-tool="rect"]');
    await drag(page, [0.3, 0.2], [0.7, 0.6]);
    await page.waitForSelector('[data-testid="mosaic-patch"]', { timeout: 30_000 });
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 60_000 });
    expect((await readdir(dir)).sort()).toEqual(['photo.jpg', 'photo_edit.jpg']);

    // Faces on a plain area: the model and onnxruntime load, and nothing is found.
    await page.click('[data-tool="faces"]');
    await drag(page, [0.02, 0.02], [0.3, 0.3]);
    const notice = page.locator('[data-testid="notice"]');
    await notice.first().waitFor({ timeout: 60_000 });
    const texts = await notice.allTextContents();
    expect(texts.join('\n')).not.toContain('Face detection failed');
    expect(texts.join('\n')).toContain('No faces found');

    // About: the notices list, the GPL text and Chromium's licences come from the package.
    await page.click('[data-testid="settings"]');
    await page.click('[data-testid="open-about"]');
    const about = page.locator('[data-testid="about"]');
    await about.waitFor();
    await page.getByText(/^Version \d/).waitFor();
    expect(await about.locator('[data-testid="about-notices"] li').count()).toBeGreaterThan(10);
    await page.click('[data-testid="about-gpl"]');
    expect(await about.locator('.licenseText').innerText()).toContain('GNU GENERAL PUBLIC LICENSE');
    await page.locator('.noticeRow', { hasText: /^react \d/ }).click();
    expect(await about.locator('.licenseText').innerText()).toContain(
      'Permission is hereby granted',
    );
    await about.getByRole('button', { name: 'Open Chromium licences' }).waitFor();
  });
});
