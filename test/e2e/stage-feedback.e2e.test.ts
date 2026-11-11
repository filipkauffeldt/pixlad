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
