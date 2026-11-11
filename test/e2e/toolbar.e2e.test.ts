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

/** Launches with one photo open and the rectangle tool picked. */
async function openPhoto(): Promise<Page> {
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
  return page;
}

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const b = (await page.locator('[data-testid="photo"]').boundingBox())!;
  const at = (p: [number, number]): [number, number] => [
    b.x + p[0] * b.width,
    b.y + p[1] * b.height,
  ];
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at(to), { steps: 8 });
  await page.mouse.up();
}

const areas = (page: Page): Promise<number> => page.locator('[data-testid="area"]').count();
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

describe('redo', () => {
  it('redoes from the button and both shortcuts, and a new edit drops it', async () => {
    const page = await openPhoto();
    await drag(page, [0.1, 0.1], [0.3, 0.3]);
    await drag(page, [0.5, 0.5], [0.7, 0.7]);
    expect(await button(page, 'Redo').isDisabled()).toBe(true);

    await button(page, 'Undo').click();
    expect(await areas(page)).toBe(1);
    expect(await button(page, 'Redo').isEnabled()).toBe(true);
    await button(page, 'Redo').click();
    expect(await areas(page)).toBe(2);
    expect(await button(page, 'Redo').isDisabled()).toBe(true);

    await page.keyboard.press('ControlOrMeta+z');
    expect(await areas(page)).toBe(1);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await areas(page)).toBe(2);

    if (process.platform !== 'darwin') {
      await page.keyboard.press('Control+z');
      expect(await areas(page)).toBe(1);
      await page.keyboard.press('Control+y');
      expect(await areas(page)).toBe(2);
    }

    await page.keyboard.press('ControlOrMeta+z');
    await drag(page, [0.1, 0.6], [0.2, 0.8]);
    expect(await button(page, 'Redo').isDisabled()).toBe(true);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await areas(page)).toBe(2);
  });
});
