import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

/** Start the built app. Chromium's own files (cache, GPU) go to a throw-away user-data folder. */
export async function launch(
  options: { userData?: string; env?: Record<string, string> } = {},
): Promise<Launched> {
  const userData = options.userData ?? (await mkdtemp(join(tmpdir(), 'mr-userdata-')));
  const app = await electron.launch({
    args: [
      join(root, 'out/main/index.js'),
      `--user-data-dir=${userData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, ...options.env } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="toolbar"]');
  await stubDialogs(app);
  return { app, page, userData };
}

/** A real file drop onto the window, through Chromium's drag-and-drop (CDP), not a synthetic event. */
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
  /** Undefined until a test chooses, so a close with no answer shows the real dialog. */
  close?: 0 | 1;
  remove: 0 | 1;
  closeAsked: string[];
  removeAsked: string[];
}

/** Answer the app's questions without a real dialog. Removal answers Keep until a test says otherwise. */
async function stubDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const stubs: DialogStubs = { remove: 1, closeAsked: [], removeAsked: [] };
    (globalThis as { __dialogs?: DialogStubs }).__dialogs = stubs;
    const real = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args[args.length - 1] as { message: string };
      if (options.message.startsWith('Remove ')) {
        stubs.removeAsked.push(options.message);
        return { response: stubs.remove, checkboxChecked: false };
      }
      if (stubs.close === undefined) return (real as (...a: unknown[]) => unknown)(...args);
      stubs.closeAsked.push(options.message);
      return { response: stubs.close, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
}

/** Answer the close confirmation without a real dialog. */
export async function stubCloseDialog(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate((_electron, answer) => {
    (globalThis as { __dialogs?: DialogStubs }).__dialogs!.close = answer;
  }, response);
}

/** Answer the question after an export: 0 removes, 1 keeps. */
export async function stubRemoveDialog(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate((_electron, answer) => {
    (globalThis as { __dialogs?: DialogStubs }).__dialogs!.remove = answer;
  }, response);
}

export const dialogMessages = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as { __dialogs?: DialogStubs }).__dialogs!.closeAsked);

export const removeMessages = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as { __dialogs?: DialogStubs }).__dialogs!.removeAsked);
