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

async function writePhoto(name: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), 'pixlad-e2e-')), name);
  await writeFile(file, await encodeJpeg(syntheticPhoto(1600, 1200)));
  return file;
}

/** The next Open dialog answers with these files instead of showing itself. */
async function answerOpenDialog(app: Launched['app'], paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: files,
    })) as unknown as typeof dialog.showOpenDialog;
  }, paths);
}

/** Launches with one photo open and the rectangle tool picked. */
async function openPhoto(): Promise<Page> {
  const file = await writePhoto('p.jpg');
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

describe('adding photos to a running session', () => {
  it('opens the file dialog from the Add button and from Ctrl/⌘+O', async () => {
    const page = await openPhoto();
    const { app } = running!;
    const thumbs = (): Promise<number> => page.locator('[data-testid="thumb"]').count();
    expect(await thumbs()).toBe(1);

    await answerOpenDialog(app, [await writePhoto('b.jpg')]);
    await button(page, 'Add…').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="thumb"]').length === 2,
    );

    await answerOpenDialog(app, [await writePhoto('c.jpg')]);
    await page.keyboard.press('ControlOrMeta+o');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="thumb"]').length === 3,
    );
    expect(await thumbs()).toBe(3);
  });

  it('works while a number field has focus, and before any photo is open', async () => {
    running = await launch();
    const { page, app } = running;
    await page.waitForSelector('[data-testid="empty"]');
    await answerOpenDialog(app, [await writePhoto('a.jpg')]);
    await page.focus('[aria-label="Block size in px"]');
    await page.keyboard.press('ControlOrMeta+o');
    await page.waitForSelector('[data-testid="photo"]');
  });
});
