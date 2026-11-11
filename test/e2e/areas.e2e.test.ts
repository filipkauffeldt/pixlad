import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { dropFiles, launch, pickTool, stubCloseDialog, type Launched } from './app';

let running: Launched | undefined;
afterEach(async () => {
  if (running) await stubCloseDialog(running.app, 0).catch(() => undefined);
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

async function photoBox(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const box = await page.locator('[data-testid="photo"]').boundingBox();
  if (!box) throw new Error('no photo on screen');
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

/** A point given as fractions of the photo, in page pixels. */
async function at(page: Page, x: number, y: number): Promise<[number, number]> {
  const b = await photoBox(page);
  return [b.x + x * b.w, b.y + y * b.h];
}

async function drawRect(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...(await at(page, ...from)));
  await page.mouse.down();
  await page.mouse.move(...(await at(page, ...to)), { steps: 6 });
  await page.mouse.up();
}

/** One photo open with two rectangles: A at x 0.1–0.3 and B at x 0.5–0.7, B drawn last. */
async function openWithTwoAreas(): Promise<Page> {
  const dir = await mkdtemp(join(tmpdir(), 'pixlad-e2e-'));
  const file = join(dir, 'p.jpg');
  await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));
  running = await launch();
  const { page } = running;
  await dropFiles(page, [file]);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await pickTool(page, 'rect');
  await drawRect(page, [0.1, 0.3], [0.3, 0.6]);
  await drawRect(page, [0.5, 0.3], [0.7, 0.6]);
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

    // Only the topmost area is highlighted, and only where it is.
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

    // A drag that starts over an area draws a new one: no hover until it ends.
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
