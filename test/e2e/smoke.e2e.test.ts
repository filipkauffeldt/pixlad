import { join } from 'node:path';
import { expect, it } from 'vitest';
import { dropFiles, launch, tempDir, writePhoto } from './app';

it('starts empty, opens a dropped photo and shows it', async () => {
  const dir = await tempDir('pixlad-smoke-');
  const file = await writePhoto(dir, 'one.jpg');
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
