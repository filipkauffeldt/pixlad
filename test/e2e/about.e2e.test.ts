import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { dropFiles, launch, type Launched } from './app';

let running: Launched | undefined;
afterEach(async () => {
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

describe('About', () => {
  it('shows the copyright, the version and every licence, and blocks shortcuts while open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pixlad-about-'));
    const file = join(dir, 'a.jpg');
    await writeFile(file, await encodeJpeg(syntheticPhoto(320, 240)));
    running = await launch();
    const { page } = running;
    await dropFiles(page, [file]);
    await page.waitForSelector('[data-testid="photo"]');

    await page.click('[data-testid="settings"]');
    await page.click('[data-testid="open-about"]');
    const about = page.locator('[data-testid="about"]');
    await about.waitFor();
    // The test build has no PIXLAD_VERSION, so it shows the fallback.
    await page.getByText('Version dev', { exact: true }).waitFor();
    expect(await about.innerText()).toContain('Copyright © 2026 Filip Kauffeldt');
    expect(await about.innerText()).toContain('github.com/filipkauffeldt/pixlad');

    await page.click('[data-testid="about-gpl"]');
    expect(await about.innerText()).toContain('GNU GENERAL PUBLIC LICENSE');
    await page.locator('.noticeRow', { hasText: /^react \d/ }).click();
    expect(await about.locator('.licenseText').innerText()).toContain(
      'Permission is hereby granted',
    );
    expect(await about.innerText()).toContain('Independent JPEG Group');

    // Delete would remove the photo from the session; with About open it does nothing.
    await page.keyboard.press('Delete');
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(1);

    await page.keyboard.press('Escape');
    await about.waitFor({ state: 'detached' });
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(1);
  });
});
