import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { dropFiles, launch, stubCloseDialog, type Launched } from './app';

let running: Launched | undefined;
afterEach(async () => {
  if (running) await stubCloseDialog(running.app, 0).catch(() => undefined);
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'pixlad-e2e-'));

async function openPhoto(page: Page, dir: string): Promise<void> {
  const file = join(dir, 'p.jpg');
  await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));
  await dropFiles(page, [file]);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
}

const photoBox = async (page: Page) => (await page.locator('[data-testid="photo"]').boundingBox())!;

describe('notices over the stage', () => {
  it('never move the photo when they appear or are dismissed, and let pointers through', async () => {
    const dir = await tmp();
    running = await launch();
    const { page } = running;
    await openPhoto(page, dir);
    const stage = (await page.locator('[data-testid="stage"]').boundingBox())!;
    const before = await photoBox(page);

    const refused = [join(dir, 'a.txt'), join(dir, 'b.txt')];
    for (const file of refused) {
      await writeFile(file, 'not a photo');
      await dropFiles(page, [file]);
    }
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="notice"]').length === 2,
    );
    expect(await photoBox(page)).toEqual(before);
    expect(await page.locator('[data-testid="stage"]').boundingBox()).toEqual(stage);

    // The notices sit inside the stage area, and the gap between two of them is not a hit target.
    const [first, second] = await page.locator('[data-testid="notice"]').all();
    const a = (await first!.boundingBox())!;
    const b = (await second!.boundingBox())!;
    expect(a.y).toBeGreaterThanOrEqual(stage.y);
    const gap = { x: a.x + a.width / 2, y: (a.y + a.height + b.y) / 2 };
    expect(gap.y).toBeGreaterThan(a.y + a.height);
    expect(gap.y).toBeLessThan(b.y);
    const hit = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="stage"]'),
      gap,
    );
    expect(hit).toBe(true);

    await page.locator('[data-testid="notice"] .close').first().click();
    await page.locator('[data-testid="notice"] .close').first().click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="notice"]').length === 0,
    );
    expect(await photoBox(page)).toEqual(before);
  });
});

/** Replace the main process's face detector: hang for good, find nothing, or fail. */
async function stubDetect(app: Launched['app'], mode: 'hang' | 'none' | 'fail'): Promise<void> {
  await app.evaluate(({ ipcMain }, how) => {
    ipcMain.removeHandler('photo:detect');
    ipcMain.handle('photo:detect', async () => {
      if (how === 'hang') await new Promise(() => undefined);
      if (how === 'fail') throw new Error('model missing');
      return [];
    });
  }, mode);
}

/** A real-mouse drag between two points given as fractions of the photo. */
async function drag(page: Page, points: Array<[number, number]>): Promise<void> {
  const box = await photoBox(page);
  const at = (p: [number, number]): [number, number] => [
    box.x + p[0] * box.width,
    box.y + p[1] * box.height,
  ];
  await page.mouse.move(...at(points[0]!));
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...at(p), { steps: 5 });
  await page.mouse.up();
}

describe('detection feedback', () => {
  it('keeps the dragged rectangle with the label beside it while it looks', async () => {
    running = await launch();
    const { page, app } = running;
    await openPhoto(page, await tmp());
    await stubDetect(app, 'hang');
    await drag(page, [
      [0.2, 0.3],
      [0.5, 0.6],
    ]);
    const label = page.locator('[data-testid="detect-label"]');
    await label.waitFor();
    expect(await label.innerText()).toBe('Looking for faces…');
    const photo = await photoBox(page);
    const region = (await page.locator('[data-testid="detect-region"]').boundingBox())!;
    expect(region.x).toBeCloseTo(photo.x + 0.2 * photo.width, -1);
    expect(region.width).toBeCloseTo(0.3 * photo.width, -1);
    const text = (await label.boundingBox())!;
    expect(Math.abs(text.x - region.x)).toBeLessThan(20);
    expect(text.y).toBeGreaterThan(region.y + region.height - 1);
    expect(await page.locator('[data-testid="notice"]').count()).toBe(0);
    expect(await page.locator('.busy').count()).toBe(0);
  });

  it('keeps a lasso as drawn while it looks', async () => {
    running = await launch();
    const { page, app } = running;
    await openPhoto(page, await tmp());
    await stubDetect(app, 'hang');
    await page.keyboard.down('Alt');
    await drag(page, [
      [0.2, 0.3],
      [0.5, 0.3],
      [0.55, 0.6],
      [0.25, 0.65],
    ]);
    await page.keyboard.up('Alt');
    await page.locator('[data-testid="detect-label"]').waitFor();
    const d = await page.locator('[data-testid="detect-region"]').getAttribute('d');
    expect(d!.split('L').length).toBeGreaterThanOrEqual(4);
  });

  it('says "No faces found" at the region for a moment, with no notice', async () => {
    running = await launch();
    const { page, app } = running;
    await openPhoto(page, await tmp());
    await stubDetect(app, 'none');
    await drag(page, [
      [0.2, 0.3],
      [0.5, 0.6],
    ]);
    const label = page.locator('[data-testid="detect-label"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="detect-label"]')?.textContent === 'No faces found',
    );
    expect(await page.locator('[data-testid="notice"]').count()).toBe(0);
    expect(await page.locator('[data-testid="detect-region"]').count()).toBe(1);
    await label.waitFor({ state: 'detached', timeout: 5000 });
    expect(await page.locator('[data-testid="detect-region"]').count()).toBe(0);
    expect(await page.locator('[data-testid="notice"]').count()).toBe(0);
  });

  it('keeps the error notice when the detector fails, and drops the region', async () => {
    running = await launch();
    const { page, app } = running;
    await openPhoto(page, await tmp());
    await stubDetect(app, 'fail');
    await drag(page, [
      [0.2, 0.3],
      [0.5, 0.6],
    ]);
    const notice = page.locator('[data-testid="notice"]');
    await notice.waitFor();
    expect(await notice.innerText()).toContain('Face detection failed');
    expect(await page.locator('[data-testid="detect-label"]').count()).toBe(0);
    expect(await page.locator('[data-testid="detect-region"]').count()).toBe(0);
  });
});
