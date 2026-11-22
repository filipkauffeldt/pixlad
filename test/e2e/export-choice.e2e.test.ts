import type { Page } from '@playwright/test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answerRemove,
  closeWithoutAsking,
  launch,
  openPhotos,
  pickTool,
  tempDir,
  type Launched,
  writePhoto,
} from './app';

let running: Launched | undefined;
afterEach(async () => {
  await closeWithoutAsking(running);
  running = undefined;
});

async function drawRect(page: Page): Promise<void> {
  const box = (await page.locator('[data-testid="photo"]').boundingBox())!;
  await pickTool(page, 'rect');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid="mosaic-patch"]');
}

/** The line under the options, once the file name has loaded. */
async function result(page: Page): Promise<string> {
  const line = page.locator('[data-testid="export-choice-result"]');
  await expect.poll(() => line.innerText()).not.toContain('…');
  return line.innerText();
}

describe('the first export', () => {
  it('asks how to save, shows the file name, and remembers the choice', async () => {
    const dir = await tempDir();
    const file = await writePhoto(dir, '_DSC1234.JPG', 1200, 900);
    const userData = await tempDir();
    running = await launch({ userData, firstRun: true });
    let { page } = running;
    await openPhotos(page, [file]);
    await drawRect(page);

    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector('[data-testid="export-choice"]');
    expect(await result(page)).toContain('Saves as');
    expect(await result(page)).toContain('_DSC1234_edit.JPG');

    await page.click('[data-testid="export-choice-overwrite"]');
    expect(await result(page)).toContain('Replaces');
    expect(await result(page)).toContain('(cannot be undone)');
    expect(await result(page)).toContain('_DSC1234.JPG');

    // Delete would remove the photo. While the choice is open it does nothing.
    await page.keyboard.press('Delete');
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(1);

    // Escape closes it and nothing is written.
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="export-choice"]', { state: 'detached' });
    expect(await readdir(dir)).toEqual(['_DSC1234.JPG']);

    // It asks again, and Enter exports with the chosen option.
    await page.click('[data-testid="export"]');
    await page.waitForSelector('[data-testid="export-choice"]');
    await page.click('[data-testid="export-choice-suffix"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30_000 });
    await answerRemove(page, 'keep');
    expect((await readdir(dir)).sort()).toEqual(['_DSC1234.JPG', '_DSC1234_edit.JPG']);
    const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as object;
    expect(saved).toMatchObject({ exportTarget: 'suffix', exportChosen: true });

    // The next export does not ask, and neither does a new start.
    await drawRect(page);
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="photo-status"]')?.textContent?.includes('replaced'),
    );
    expect(await page.locator('[data-testid="export-choice"]').count()).toBe(0);
    await closeWithoutAsking(running);

    running = await launch({ userData });
    page = running.page;
    await openPhotos(page, [file]);
    await drawRect(page);
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="photo-status"]')?.textContent?.includes('Saved'),
    );
    expect(await page.locator('[data-testid="export-choice"]').count()).toBe(0);
  });

  it('asks from Export all with the number of photos, and shows the next free name', async () => {
    const dir = await tempDir();
    const one = await writePhoto(dir, 'one.jpg', 1200, 900);
    const two = await writePhoto(dir, 'two.jpg', 1200, 900);
    await writeFile(join(dir, 'one_edit.jpg'), 'an earlier export');
    running = await launch({ firstRun: true });
    const { page } = running;
    await openPhotos(page, [one, two]);
    await drawRect(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('[data-testid="photo"]');
    await drawRect(page);

    await page.click('[data-testid="export-all"]');
    await page.waitForSelector('[data-testid="export-choice"]');
    expect(await result(page)).toContain('Saves 2 photos, for example');
    expect(await result(page)).toContain('one_edit-2.jpg');
    expect(await page.locator('[data-testid="export-choice-confirm"]').innerText()).toBe(
      'Export 2',
    );

    await page.click('[data-testid="export-choice-confirm"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="batch-status"]')?.textContent ===
        '2 exported, 0 failed',
      undefined,
      { timeout: 60_000 },
    );
    expect((await readdir(dir)).sort()).toEqual([
      'one.jpg',
      'one_edit-2.jpg',
      'one_edit.jpg',
      'two.jpg',
      'two_edit.jpg',
    ]);
  });
});
