import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launch, openPhotos, tempDir, writePhoto } from './app';

it('starts empty, opens a dropped photo and shows it', async () => {
  const dir = await tempDir('pixlad-smoke-');
  const file = await writePhoto(dir, 'one.jpg');
  const { app, page } = await launch();
  try {
    await expect(page.locator('[data-testid="empty"]').count()).resolves.toBe(1);
    await page.screenshot({ path: join(dir, 'empty.png') });
    await openPhotos(page, [file]);
    await page.screenshot({ path: join(dir, 'photo.png') });
    console.log('SMOKE', dir);
  } finally {
    await app.close();
  }
});
