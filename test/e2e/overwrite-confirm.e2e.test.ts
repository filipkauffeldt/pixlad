import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answerRemove,
  closeWithoutAsking,
  drawMosaic,
  launch,
  openPhotos,
  tempDir,
  type Launched,
  waitForExport,
  writePhoto,
} from './app';

let running: Launched | undefined;
afterEach(async () => {
  await closeWithoutAsking(running);
  running = undefined;
});

const dialog = '[data-testid="overwrite-confirm"]';

async function replacingUser(): Promise<string> {
  const userData = await tempDir();
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ exportTarget: 'overwrite', exportChosen: true }),
  );
  return userData;
}

describe('confirming Replace original', () => {
  it('leaves the file alone on Cancel, with the focus on Cancel, and writes on Replace', async () => {
    const dir = await tempDir();
    const file = await writePhoto(dir, 'one.jpg', 1200, 900);
    const before = await readFile(file);
    running = await launch({ userData: await replacingUser() });
    const { page } = running;
    await openPhotos(page, [file]);
    await drawMosaic(page);

    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector(dialog);
    expect(await page.locator(dialog).innerText()).toContain('one.jpg');
    expect(await page.locator(dialog).innerText()).toContain('This cannot be undone.');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'overwrite-confirm-cancel',
    );

    await page.keyboard.press('Escape');
    await page.waitForSelector(dialog, { state: 'detached' });
    expect(Buffer.compare(await readFile(file), before)).toBe(0);

    await page.click('[data-testid="export"]');
    await page.click('[data-testid="overwrite-confirm-replace"]');
    await waitForExport(page);
    expect(Buffer.compare(await readFile(file), before)).not.toBe(0);
    expect(await readdir(dir)).toEqual(['one.jpg']);
  });

  it('asks from Export all with the number of photos', async () => {
    const dir = await tempDir();
    const one = await writePhoto(dir, 'one.jpg', 1200, 900);
    const two = await writePhoto(dir, 'two.jpg', 1200, 900);
    running = await launch({ userData: await replacingUser() });
    const { page } = running;
    await openPhotos(page, [one, two]);
    await drawMosaic(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('[data-testid="photo"]');
    await drawMosaic(page);

    await page.click('[data-testid="export-all"]');
    await page.waitForSelector(dialog);
    const text = await page.locator(dialog).innerText();
    expect(text).toContain('Replace 2 originals?');
    expect(text).toContain('one.jpg');
    expect(text).toContain('two.jpg');
    expect(await page.locator('[data-testid="overwrite-confirm-replace"]').innerText()).toBe(
      'Replace 2',
    );
  });

  it('does not ask again this session when ticked, but asks again after a restart', async () => {
    const dir = await tempDir();
    const userData = await replacingUser();
    const one = await writePhoto(dir, 'one.jpg', 1200, 900);
    const two = await writePhoto(dir, 'two.jpg', 1200, 900);
    running = await launch({ userData });
    let { page } = running;
    await openPhotos(page, [one, two]);
    await drawMosaic(page);

    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector(dialog);
    await page.check('[data-testid="overwrite-confirm-dont-ask"]');
    await page.click('[data-testid="overwrite-confirm-replace"]');
    await waitForExport(page);
    await answerRemove(page, 'keep');

    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('[data-testid="photo"]');
    await drawMosaic(page);
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="badge-exported"]').length === 2,
      undefined,
      { timeout: 30_000 },
    );
    expect(await page.locator(dialog).count()).toBe(0);

    await closeWithoutAsking(running);
    running = await launch({ userData });
    ({ page } = running);
    await openPhotos(page, [one]);
    await drawMosaic(page);
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector(dialog);
  });
});
