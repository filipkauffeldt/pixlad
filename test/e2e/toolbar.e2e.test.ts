import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
async function openPhoto(file?: string): Promise<Page> {
  file ??= await writePhoto('p.jpg');
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

async function centreOfFirstArea(page: Page): Promise<[number, number]> {
  const box = (await page.locator('[data-testid="area"]').first().boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

const areas = (page: Page): Promise<number> => page.locator('[data-testid="area"]').count();
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

describe('undo and redo buttons', () => {
  it('are curved arrows with an accessible name, not text', async () => {
    const page = await openPhoto();
    for (const name of ['Undo', 'Redo']) {
      const arrow = button(page, name);
      expect(await arrow.locator('svg').count()).toBe(1);
      expect((await arrow.textContent())?.trim()).toBe('');
      expect(await arrow.getAttribute('title')).toContain(name);
    }
  });
});

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

describe('finding all faces', () => {
  const crew = resolve(import.meta.dirname, '../../fixtures/apollo11_crew.jpg');
  const faceCount = async (page: Page): Promise<number> => {
    const text = await page.locator('[data-testid="face-count"]').textContent();
    return Number(/of (\d+)/.exec(text ?? '')?.[1] ?? 0);
  };

  it('is off with no photo open', async () => {
    running = await launch();
    await running.page.waitForSelector('[data-testid="empty"]');
    expect(await button(running.page, 'Find all faces').isDisabled()).toBe(true);
    await running.page.keyboard.press('f');
    expect(await running.page.locator('[data-testid="detect-label"]').count()).toBe(0);
  });

  it('finds the faces from the button and from F, and F types in a field', async (ctx) => {
    if (!existsSync(crew)) return ctx.skip(); // fetched by `pnpm fetch-fixtures`
    const file = join(await mkdtemp(join(tmpdir(), 'pixlad-e2e-')), 'crew.jpg');
    await copyFile(crew, file);
    const page = await openPhoto(file);
    expect(await button(page, 'Find all faces').isEnabled()).toBe(true);

    await button(page, 'Find all faces').click();
    await page.waitForSelector('[data-testid="face-count"]', { timeout: 30000 });
    const total = await faceCount(page);
    expect(total).toBeGreaterThanOrEqual(3);
    expect(await button(page, 'Find all faces').isEnabled()).toBe(true);
    // Found faces and their count do not push the toolbar onto a second row.
    expect((await page.locator('[data-testid="toolbar"]').boundingBox())!.height).toBeLessThan(50);

    // The same faces found again are not added twice.
    await button(page, 'Find all faces').click();
    await page.locator('[data-testid="detect-label"]').waitFor({ state: 'detached' });
    expect(await faceCount(page)).toBe(total);

    // Take them away with Subtract over the whole photo, then F brings them back.
    await pickTool(page, 'faces');
    await page.click('[data-mode="subtract"]');
    await drag(page, [-0.01, -0.01], [1.01, 1.01]);
    await page.waitForFunction(() => !document.querySelector('[data-testid="face-count"]'));
    await page.click('[data-mode="add"]');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('f');
    await page.waitForSelector('[data-testid="face-count"]', { timeout: 30000 });
    expect(await faceCount(page)).toBe(total);

    // Typing an f into a field is typing, not a command.
    const field = page.locator('[aria-label="Block size in px"]');
    await field.focus();
    await page.keyboard.press('f');
    expect(await field.inputValue()).toMatch(/f$/);
    expect(await page.locator('[data-testid="detect-label"]').count()).toBe(0);
  });

  it('says so at the photo when there are no faces to find', async () => {
    const page = await openPhoto();
    await button(page, 'Find all faces').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="detect-label"]')?.textContent === 'No faces found',
    );
    expect(await page.locator('[data-testid="notice"]').count()).toBe(0);
    expect(await page.locator('[data-testid="detect-region"]').count()).toBe(0);
    expect(await button(page, 'Find all faces').isEnabled()).toBe(true);
  });

  it('labels the whole photo while it looks, with no outline, and is off meanwhile', async () => {
    const page = await openPhoto();
    await running!.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('photo:detect');
      ipcMain.handle('photo:detect', () => new Promise(() => undefined));
    });
    await button(page, 'Find all faces').click();
    const label = page.locator('[data-testid="detect-label"]');
    await label.waitFor();
    expect(await label.innerText()).toBe('Looking for faces…');
    expect(await page.locator('[data-testid="detect-region"]').count()).toBe(0);
    expect(await button(page, 'Find all faces').isDisabled()).toBe(true);
    await page.keyboard.press('f');
    expect(await label.count()).toBe(1);
  });
});

describe('the Export tooltip', () => {
  it('says what is missing while there is no mosaic, then goes back to the usual text', async () => {
    const page = await openPhoto();
    const exportButton = page.locator('[data-testid="export"]');
    expect(await exportButton.isDisabled()).toBe(true);
    expect(await exportButton.getAttribute('title')).toBe('Draw an area or find faces first');

    await drag(page, [0.2, 0.2], [0.5, 0.5]);
    expect(await exportButton.isEnabled()).toBe(true);
    expect(await exportButton.getAttribute('title')).toContain('Save a new copy');

    // An area switched off is no mosaic either.
    await page.mouse.click(...(await centreOfFirstArea(page)));
    expect(await exportButton.isDisabled()).toBe(true);
    expect(await exportButton.getAttribute('title')).toBe('Draw an area or find faces first');
  });
});

describe('the sliders', () => {
  it('grabs the thumb from a few pixels beside its line, and drags it', async () => {
    const page = await openPhoto();
    const slider = page.locator('[aria-label="Face padding"]');
    const box = (await slider.boundingBox())!;
    const value = async (): Promise<number> => Number(await slider.inputValue());
    const start = await value(); // 0.15 of 0..0.5
    // Chromium keeps the thumb's own width inside the track at both ends.
    const thumb = 14;
    const centre = box.x + thumb / 2 + (start / 0.5) * (box.width - thumb);
    const y = box.y + box.height / 2;

    // Pressing on the track outside the thumb would jump the value to the pointer.
    await page.mouse.move(centre + 5, y);
    await page.mouse.down();
    expect(await value()).toBe(start);
    await page.mouse.move(centre + 25, y, { steps: 5 });
    expect(await value()).toBeGreaterThan(start + 0.05);
    await page.mouse.up();
  });
});

describe('the slider labels', () => {
  it('use the muted text colour, not the dim one reserved for disabled states', async () => {
    running = await launch();
    const { page } = running;
    await page.waitForSelector('[data-testid="empty"]');
    const colours = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const resolve = (token: string): string => {
        const probe = document.createElement('span');
        probe.style.color = root.getPropertyValue(token);
        document.body.append(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      };
      const of = (selector: string): string[] =>
        [...document.querySelectorAll(selector)].map((e) => getComputedStyle(e).color);
      return {
        muted: resolve('--muted'),
        labels: of('.control .label'),
        units: of('.control .unit'),
      };
    });
    expect(colours.labels).toEqual([colours.muted, colours.muted]);
    expect(colours.units).toEqual([colours.muted, colours.muted]);
  });
});

describe('tooltips', () => {
  it('show the shortcut keys of this platform only, and explain Padding', async () => {
    const page = await openPhoto();
    const title = (selector: string): Promise<string> =>
      page
        .locator(selector)
        .first()
        .getAttribute('title')
        .then((t) => t ?? '');
    const mac = process.platform === 'darwin';
    const mod = mac ? '⌘' : 'Ctrl';
    const other = mac ? 'Ctrl' : '⌘';
    await drag(page, [0.2, 0.2], [0.5, 0.5]); // Export has its usual tooltip once there is a mosaic

    const titles = {
      add: await title('[data-testid="add-photos"]'),
      undo: await page.getByRole('button', { name: 'Undo', exact: true }).getAttribute('title'),
      redo: await page.getByRole('button', { name: 'Redo', exact: true }).getAttribute('title'),
      export: await title('[data-testid="export"]'),
    };
    expect(titles.add).toContain(`${mod}+O`);
    expect(titles.undo).toContain(`${mod}+Z`);
    expect(titles.export).toContain(`${mod}+E`);
    expect(titles.redo).toContain(mac ? '⌘+Shift+Z' : 'Ctrl+Shift+Z or Ctrl+Y');
    for (const text of Object.values(titles)) {
      expect(text).not.toContain('/');
      expect(text).not.toContain(`${other}+`);
    }

    const padding = await page.locator('.control', { hasText: 'Padding' }).getAttribute('title');
    expect(padding).toContain('mosaic grows');
    expect(padding).toContain('detected face');
  });
});

describe('the area counts', () => {
  it('are in the footer, and the toolbar stays on one row in the default window', async () => {
    const page = await openPhoto();
    const toolbar = page.locator('[data-testid="toolbar"]');
    const singleRow = (await toolbar.boundingBox())!.height;
    expect(await page.locator('[data-testid="footer"] [data-testid="area-counts"]').count()).toBe(
      1,
    );
    expect(await page.locator('[data-testid="drawn-count"]').count()).toBe(0);

    await drag(page, [0.2, 0.2], [0.5, 0.5]);
    await drag(page, [0.6, 0.6], [0.8, 0.8]);
    const counts = page.locator('[data-testid="footer"] [data-testid="drawn-count"]');
    expect(await counts.textContent()).toBe('2 of 2 areas on');
    expect(await toolbar.locator('[data-testid="area-counts"]').count()).toBe(0);
    expect((await toolbar.boundingBox())!.height).toBe(singleRow);

    await page.mouse.click(...(await centreOfFirstArea(page)));
    expect(await counts.textContent()).toBe('1 of 2 areas on');
    // The readout comes after the photo's name and size.
    const status = await page.locator('[data-testid="photo-status"]').innerText();
    expect(status.indexOf('1600×1200')).toBeLessThan(status.indexOf('areas on'));
  });
});
