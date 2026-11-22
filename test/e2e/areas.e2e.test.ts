import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  areaCount,
  closeWithoutAsking,
  dragOnPhoto,
  launch,
  openPhotos,
  photoBox,
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

async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  const b = await photoBox(page);
  return [b.x + x * b.w, b.y + y * b.h];
}

async function openWithTwoAreas({ firstRun = false } = {}): Promise<Page> {
  const dir = await tempDir();
  const file = await writePhoto(dir, 'p.jpg');
  running = await launch({ firstRun });
  const { page } = running;
  await openPhotos(page, [file]);
  await pickTool(page, 'rect');
  await dragOnPhoto(page, [
    [0.1, 0.3],
    [0.3, 0.6],
  ]);
  await dragOnPhoto(page, [
    [0.5, 0.3],
    [0.7, 0.6],
  ]);
  expect(await page.locator('[data-testid="area"]').count()).toBe(2);
  return page;
}

const cursor = (page: Page): Promise<string> =>
  page.locator('[data-testid="stage"]').evaluate((el) => getComputedStyle(el).cursor);
const hoveredCount = (page: Page): Promise<number> =>
  page.locator('[data-testid="area"].areaHover').count();

describe('hovering an area', () => {
  it('highlights the area under the pointer and shows a pointer cursor', async () => {
    const page = await openWithTwoAreas();
    await page.mouse.move(...(await at(page, 0.9, 0.9)));
    expect(await cursor(page)).toBe('crosshair');
    expect(await hoveredCount(page)).toBe(0);

    await page.mouse.move(...(await at(page, 0.2, 0.45)));
    expect(await cursor(page)).toBe('pointer');
    expect(await hoveredCount(page)).toBe(1);
    await expect(
      page.locator('[data-testid="area"]').first().getAttribute('class'),
    ).resolves.toContain('areaHover');

    await page.mouse.move(...(await at(page, 0.6, 0.45)));
    await expect(
      page.locator('[data-testid="area"]').nth(1).getAttribute('class'),
    ).resolves.toContain('areaHover');
    expect(await hoveredCount(page)).toBe(1);

    await page.mouse.move(...(await at(page, 0.4, 0.45)));
    expect(await cursor(page)).toBe('crosshair');
    expect(await hoveredCount(page)).toBe(0);
  });

  it('does not highlight during a drag or while Space is held', async () => {
    const page = await openWithTwoAreas();
    await page.mouse.move(...(await at(page, 0.2, 0.45)));
    expect(await hoveredCount(page)).toBe(1);

    await page.mouse.down();
    await page.mouse.move(...(await at(page, 0.25, 0.5)), { steps: 4 });
    expect(await hoveredCount(page)).toBe(0);
    expect(await cursor(page)).toBe('crosshair');
    await page.mouse.up();
    expect(await hoveredCount(page)).toBe(1);

    await page.keyboard.down('Space');
    expect(await hoveredCount(page)).toBe(0);
    expect(await cursor(page)).toBe('grab');
    await page.keyboard.up('Space');
    expect(await hoveredCount(page)).toBe(1);
  });
});

const photosInSession = (page: Page): Promise<string> =>
  page
    .locator('[data-testid="thumb"]')
    .evaluateAll((thumbs) => thumbs.map((t) => (t as HTMLElement).dataset['name']).join('\n'));

describe('removing an area', () => {
  it('right-click removes the topmost area under the pointer and Undo restores it', async () => {
    const page = await openWithTwoAreas();
    await page.mouse.click(...(await at(page, 0.4, 0.45)), { button: 'right' });
    expect(await areaCount(page)).toBe(2);

    await page.mouse.click(...(await at(page, 0.2, 0.45)), { button: 'right' });
    expect(await areaCount(page)).toBe(1);
    const left = (await page.locator('[data-testid="area"]').first().boundingBox())!;
    const b = await photoBox(page);
    expect(left.x).toBeGreaterThan(b.x + 0.45 * b.w);

    await page.keyboard.press('Control+z');
    expect(await areaCount(page)).toBe(2);
  });

  it('Delete and Backspace remove the area under the pointer and keep the photo', async () => {
    const page = await openWithTwoAreas();
    const status = await photosInSession(page);
    await page.mouse.move(...(await at(page, 0.6, 0.45)));
    await page.keyboard.press('Delete');
    expect(await areaCount(page)).toBe(1);
    await page.mouse.move(...(await at(page, 0.2, 0.45)));
    await page.keyboard.press('Backspace');
    expect(await areaCount(page)).toBe(0);
    await expect(photosInSession(page)).resolves.toBe(status);
    await expect(page.locator('[data-testid="photo"]').count()).resolves.toBe(1);
  });

  it('Delete with the pointer off every area still removes the photo from the session', async () => {
    const page = await openWithTwoAreas();
    await page.mouse.move(...(await at(page, 0.4, 0.45)));
    await page.keyboard.press('Delete');
    await page.locator('[data-testid="remove-photo-remove"]').click();
    await page.waitForSelector('[data-testid="empty"]');
    await expect(page.locator('[data-testid="photo"]').count()).resolves.toBe(0);
  });

  it('leaves areas alone while a dialog is open over a resting pointer', async () => {
    const page = await openWithTwoAreas({ firstRun: true });
    await page.mouse.move(...(await at(page, 0.2, 0.45)));
    expect(await hoveredCount(page)).toBe(1);

    await page.keyboard.press('Control+e');
    await page.waitForSelector('[data-testid="export-choice"]');
    expect(await hoveredCount(page)).toBe(0);
    expect(await cursor(page)).toBe('crosshair');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    expect(await areaCount(page)).toBe(2);

    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="export-choice"]', { state: 'detached' });
    expect(await hoveredCount(page)).toBe(1);
    await page.keyboard.press('Delete');
    expect(await areaCount(page)).toBe(1);
  });

  it('leaves areas alone under the shortcuts sheet', async () => {
    const page = await openWithTwoAreas();
    await page.mouse.move(...(await at(page, 0.2, 0.45)));
    expect(await hoveredCount(page)).toBe(1);

    await page.keyboard.press('?');
    await page.waitForSelector('[data-testid="shortcuts"]');
    expect(await hoveredCount(page)).toBe(0);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    expect(await areaCount(page)).toBe(2);

    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="shortcuts"]', { state: 'detached' });
    // The sheet covered the stage, so the pointer has to move for the hover to come back.
    await page.mouse.move(...(await at(page, 0.21, 0.45)));
    expect(await hoveredCount(page)).toBe(1);
  });
});
