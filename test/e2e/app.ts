import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';

const root = resolve(import.meta.dirname, '../..');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

export async function launch(
  options: {
    userData?: string;
    env?: Record<string, string>;
    executablePath?: string;
    firstRun?: boolean;
  } = {},
): Promise<Launched> {
  const userData = options.userData ?? (await mkdtemp(join(tmpdir(), 'pixlad-userdata-')));
  const settings = join(userData, 'settings.json');
  const exists = await access(settings).then(
    () => true,
    () => false,
  );
  if (!options.firstRun && !exists) {
    await writeFile(settings, JSON.stringify({ exportTarget: 'suffix', exportChosen: true }));
  }
  const app = await electron.launch({
    executablePath: options.executablePath,
    args: [
      // The project folder, so app.getVersion() finds package.json.
      ...(options.executablePath ? [] : [root]),
      `--user-data-dir=${userData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, ...options.env } as Record<string, string>,
    // Playwright would force a light system theme and hide the theme setting.
    colorScheme: null,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="toolbar"]');
  await stubDialogs(app);
  return { app, page, userData };
}

export async function openAbout(page: Page): Promise<void> {
  await page.click('[data-testid="settings"]');
  await page.click('[data-testid="open-about"]');
  await page.locator('[data-testid="about"]').waitFor();
}

export async function pickTool(page: Page, tool: 'faces' | 'rect' | 'lasso'): Promise<void> {
  await page.click(`[data-target="${tool === 'faces' ? 'faces' : 'area'}"]`);
  await page.click(`[data-outline="${tool === 'lasso' ? 'lasso' : 'rect'}"]`);
}

export async function photoBox(
  page: Page,
): Promise<{ x: number; y: number; w: number; h: number }> {
  const box = await page.locator('[data-testid="photo"]').boundingBox();
  if (!box) throw new Error('no photo on screen');
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

export const areaCount = (page: Page): Promise<number> =>
  page.locator('[data-testid="area"]').count();

export const currentPhoto = (page: Page): Promise<string | null> =>
  page.locator('[data-testid="thumb"][aria-current="true"]').getAttribute('data-name');

export async function dragOnPhoto(
  page: Page,
  points: Array<[number, number]>,
  steps = 6,
): Promise<void> {
  const box = (await page.locator('[data-testid="photo"]').boundingBox())!;
  const at = ([x, y]: [number, number]): [number, number] => [
    box.x + x * box.width,
    box.y + y * box.height,
  ];
  await page.mouse.move(...at(points[0]!));
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...at(point), { steps });
  await page.mouse.up();
}

export async function drawMosaic(page: Page): Promise<void> {
  await pickTool(page, 'rect');
  await dragOnPhoto(page, [
    [0.2, 0.2],
    [0.5, 0.5],
  ]);
  await page.waitForSelector('[data-testid="mosaic-patch"]');
}

export const movePointerOffAreas = async (page: Page): Promise<void> => {
  const box = (await page.locator('[data-testid="photo"]').boundingBox())!;
  await page.mouse.move(box.x + 0.9 * box.width, box.y + 0.9 * box.height);
};

export const waitForPhoto = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });

export async function openPhotos(page: Page, paths: string[]): Promise<void> {
  await dropFiles(page, paths);
  await waitForPhoto(page);
}

/** A real file drop through Chromium's drag-and-drop (CDP), not a synthetic event. */
export async function dropFiles(
  page: Page,
  paths: string[],
  at = { x: 600, y: 400 },
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...at, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...at, data });
  await cdp.detach();
}

interface DialogStubs {
  close?: 0 | 1;
  closeAsked: string[];
}

async function stubDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const stubs: DialogStubs = { closeAsked: [] };
    (globalThis as { __dialogs?: DialogStubs }).__dialogs = stubs;
    const real = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { message: string };
      if (stubs.close === undefined) return (real as (...a: unknown[]) => unknown)(...args);
      stubs.closeAsked.push(options.message);
      return { response: stubs.close, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
}

export async function closeWithoutAsking(running: Launched | undefined): Promise<void> {
  if (running) await stubCloseDialog(running.app, 'close').catch(() => undefined);
  await running?.app.close().catch(() => undefined);
}

export async function stubCloseDialog(
  app: ElectronApplication,
  response: 'close' | 'cancel',
): Promise<void> {
  await app.evaluate((_electron, answer) => {
    (globalThis as { __dialogs?: DialogStubs }).__dialogs!.close = answer === 'close' ? 0 : 1;
  }, response);
}

export const tempDir = (prefix = 'pixlad-e2e-'): Promise<string> => mkdtemp(join(tmpdir(), prefix));

export async function writePhoto(
  dir: string,
  name: string,
  width = 1600,
  height = 1200,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, await encodeJpeg(syntheticPhoto(width, height)));
  return path;
}

export const dialogMessages = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as { __dialogs?: DialogStubs }).__dialogs!.closeAsked);

export const waitForExport = (page: Page): Promise<unknown> =>
  page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30_000 });

export const waitForRemoveQuestion = (page: Page): Promise<unknown> =>
  page.waitForSelector('[data-testid="remove-exported"]', { timeout: 30_000 });

export const removeQuestion = (page: Page): Promise<string> =>
  page.locator('[data-testid="remove-exported"] h2').innerText();

export const answerRemove = (page: Page, answer: 'remove' | 'keep'): Promise<void> =>
  page.click(`[data-testid="remove-exported-${answer}"]`);
