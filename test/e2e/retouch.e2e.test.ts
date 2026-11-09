import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { dropFiles, launch, stubCloseDialog, type Launched } from './app';

let running: Launched | undefined;
afterEach(async () => {
  // Closing with unexported mosaics asks first; the tests answer "Close anyway".
  if (running) await stubCloseDialog(running.app, 0).catch(() => undefined);
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'pixlad-e2e-'));

async function photoBox(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  const box = await page.locator('[data-testid="photo"]').boundingBox();
  if (!box) throw new Error('no photo on screen');
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

/** A real-mouse drag between two points given as fractions of the photo (may be outside 0..1). */
async function drag(
  page: Page,
  from: [number, number],
  to: [number, number],
  alt = false,
): Promise<void> {
  const b = await photoBox(page);
  const at = (p: [number, number]): [number, number] => [b.x + p[0] * b.w, b.y + p[1] * b.h];
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]), { steps: 5 });
  await page.mouse.move(...at(to), { steps: 5 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

async function open(page: Page, paths: string[]): Promise<void> {
  await dropFiles(page, paths);
  await page.waitForSelector('[data-testid="photo"]', { timeout: 15000 });
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
}

const areas = (page: Page): Promise<number> => page.locator('[data-testid="area"]').count();

describe('drawing with the real mouse', () => {
  it('starts a drag in the margin around the picture', async () => {
    const dir = await tmp();
    const file = join(dir, 'p.jpg');
    await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));
    running = await launch();
    const { page } = running;
    await open(page, [file]);
    await page.click('[data-tool="rect"]');
    const b = await photoBox(page);
    // The photo is height-bound in this window, so there is room to the left of it.
    await page.mouse.move(b.x - 32, b.y + 0.3 * b.h);
    await page.mouse.down();
    await page.mouse.move(b.x + 0.3 * b.w, b.y + 0.5 * b.h, { steps: 5 });
    await page.mouse.up();
    expect(await areas(page)).toBe(1);
  });

  it('puts a rectangle under the pointer, clips from the margin, toggles, undoes', async () => {
    const dir = await tmp();
    const file = join(dir, 'p.jpg');
    await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));
    running = await launch();
    const { page } = running;
    await open(page, [file]);
    await page.click('[data-tool="rect"]');

    await drag(page, [0.2, 0.2], [0.4, 0.5]);
    expect(await areas(page)).toBe(1);
    const path = page.locator('[data-testid="area"]').first();
    const area = (await path.boundingBox())!;
    const b = await photoBox(page);
    // Playwright's box for an SVG path grows by the stroke on every side, so compare the centre
    // (must be exact to a pixel) and the size (a few pixels more than the geometry).
    const centre = (box: { x: number; y: number; width: number; height: number }): number[] => [
      box.x + box.width / 2,
      box.y + box.height / 2,
    ];
    const expectedCentre = [b.x + 0.3 * b.w, b.y + 0.35 * b.h];
    expect(Math.abs(centre(area)[0]! - expectedCentre[0]!)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(centre(area)[1]! - expectedCentre[1]!)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(area.width - 0.2 * b.w)).toBeLessThanOrEqual(6);
    expect(Math.abs(area.height - 0.3 * b.h)).toBeLessThanOrEqual(6);
    await page.waitForSelector('[data-testid="mosaic-patch"]');

    // A drag that starts just outside the photo is clipped to it.
    await drag(page, [-0.01, 0.8], [0.3, 0.95]);
    expect(await areas(page)).toBe(2);
    const clipped = (await page.locator('[data-testid="area"]').nth(1).boundingBox())!;
    // Clipped to the photo's left edge (the stroke adds up to 2 px outside).
    expect(clipped.x).toBeGreaterThanOrEqual(b.x - 3);
    expect(clipped.x).toBeLessThanOrEqual(b.x + 1);

    // A click toggles the area under it.
    const click = { x: b.x + 0.3 * b.w, y: b.y + 0.35 * b.h };
    await page.mouse.click(click.x, click.y);
    await expect(
      page.locator('[data-testid="area"]').first().getAttribute('data-enabled'),
    ).resolves.toBe('false');
    await page.mouse.click(click.x, click.y);
    await expect(
      page.locator('[data-testid="area"]').first().getAttribute('data-enabled'),
    ).resolves.toBe('true');

    // Subtract adds an area that takes mosaic away; Undo removes it again.
    await page.click('[data-mode="subtract"]');
    await drag(page, [0.25, 0.25], [0.3, 0.3]);
    expect(await areas(page)).toBe(3);
    await page.keyboard.press('Control+z');
    expect(await areas(page)).toBe(2);

    // Reset clears every area, and Undo brings them back.
    await page.click('[data-testid="reset"]');
    expect(await areas(page)).toBe(0);
    await expect(page.locator('[data-testid="reset"]').isDisabled()).resolves.toBe(true);
    await page.keyboard.press('Control+z');
    expect(await areas(page)).toBe(2);
  });

  it('finds faces, subtract removes them, and a click toggles one', async () => {
    const dir = await tmp();
    const source = resolve(import.meta.dirname, '../../fixtures/apollo11_crew.jpg');
    if (!existsSync(source)) return; // fetched by `pnpm fetch-fixtures`
    const file = join(dir, 'crew.jpg');
    await copyFile(source, file);
    running = await launch();
    const { page } = running;
    await open(page, [file]);
    await drag(page, [-0.01, -0.01], [1.01, 1.01]);
    await page
      .waitForSelector('[data-testid="face-count"]', { timeout: 30000 })
      .catch(async (cause) => {
        throw new Error(
          `${cause}\nnotices: ${await page.locator('[data-testid="notice"]').allTextContents()}`,
        );
      });
    const text = (await page.locator('[data-testid="face-count"]').textContent())!;
    const total = Number(/of (\d+)/.exec(text)![1]);
    expect(total).toBeGreaterThanOrEqual(3);
    // click the first face off and on
    const first = (await page
      .locator('[data-testid="area"][data-kind="face"]')
      .first()
      .boundingBox())!;
    await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
    await expect(page.locator('[data-testid="face-count"]').textContent()).resolves.toContain(
      `${total - 1} of ${total}`,
    );
    // Subtract in Faces removes every face in the dragged area
    await page.click('[data-mode="subtract"]');
    await drag(page, [-0.01, -0.01], [1.01, 1.01]);
    await expect(page.locator('[data-testid="face-count"]').count()).resolves.toBe(0);
  });

  it('exports next to the source as _edit and never touches the source', async () => {
    const dir = await tmp();
    const file = join(dir, '_DSC1234.JPG');
    const bytes = await encodeJpeg(syntheticPhoto(1600, 1200), { quality: 92 });
    await writeFile(file, bytes);
    running = await launch();
    const { page } = running;
    await open(page, [file]);
    await page.click('[data-tool="rect"]');
    await drag(page, [0.3, 0.2], [0.7, 0.6]);
    await page.waitForSelector('[data-testid="mosaic-patch"]');
    await page.keyboard.press('Control+e');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30000 });
    expect((await readdir(dir)).sort()).toEqual(['_DSC1234.JPG', '_DSC1234_edit.JPG']);
    expect(Buffer.compare(await readFile(file), bytes)).toBe(0);
    // Exporting the same photo again replaces this session's own file.
    await drag(page, [0.1, 0.7], [0.2, 0.9]);
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="photo-status"]')?.textContent?.includes('replaced'),
    );
    expect((await readdir(dir)).sort()).toEqual(['_DSC1234.JPG', '_DSC1234_edit.JPG']);
  });
});
