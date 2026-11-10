import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

/**
 * Start the built app, or the packaged one when `executablePath` is given. Chromium's own files
 * (cache, GPU) go to a throw-away user-data folder.
 */
export async function launch(
  options: {
    userData?: string;
    env?: Record<string, string>;
    executablePath?: string;
    /** Start like a new install, so the first export asks how to save. */
    firstRun?: boolean;
  } = {},
): Promise<Launched> {
  const userData = options.userData ?? (await mkdtemp(join(tmpdir(), 'pixlad-userdata-')));
  // Most tests act as a user who already chose how to save. A settings file that is already
  // there, from an earlier launch of the same test, is left as it is.
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
      // The project folder, as `electron .` and `pnpm start` run it, so app.getVersion() finds
      // package.json. The folder's "main" is out/main/index.js.
      ...(options.executablePath ? [] : [root]),
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

/** Choose what a drag does: faces, or a drawn area as a rectangle or a lasso. */
export async function pickTool(page: Page, tool: 'faces' | 'rect' | 'lasso'): Promise<void> {
  await page.click('[data-testid="target"]');
  await page.click(`[data-target="${tool === 'faces' ? 'faces' : 'area'}"]`);
  await page.click(`[data-outline="${tool === 'lasso' ? 'lasso' : 'rect'}"]`);
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
  closeAsked: string[];
}

/** Answer the close and restart questions without a real dialog, once a test chooses. */
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

/** Answer the close confirmation without a real dialog. */
export async function stubCloseDialog(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate((_electron, answer) => {
    (globalThis as { __dialogs?: DialogStubs }).__dialogs!.close = answer;
  }, response);
}

export const dialogMessages = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as { __dialogs?: DialogStubs }).__dialogs!.closeAsked);

/** The question after an export, as the app shows it. */
export const removeQuestion = (page: Page): Promise<string> =>
  page.locator('[data-testid="remove-exported"] h2').innerText();

/** Answer the question after an export. */
export const answerRemove = (page: Page, answer: 'remove' | 'keep'): Promise<void> =>
  page.click(`[data-testid="remove-exported-${answer}"]`);
