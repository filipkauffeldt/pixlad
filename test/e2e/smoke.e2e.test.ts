import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { dropFiles, launch } from './app';

it('starts empty, opens a dropped photo and shows it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixlad-smoke-'));
  const file = join(dir, 'one.jpg');
  await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));
  const { app, page } = await launch();
  try {
    await expect(page.locator('[data-testid="empty"]').count()).resolves.toBe(1);
    await page.screenshot({ path: join(dir, 'empty.png') });
    await dropFiles(page, [file]);
    await page.waitForSelector('[data-testid="photo"]', { timeout: 15000 });
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    await page.screenshot({ path: join(dir, 'photo.png') });
    console.log('SMOKE', dir);
  } finally {
    await app.close();
  }
});
