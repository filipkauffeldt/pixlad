// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  session as electronSession,
  screen,
  shell,
} from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SETTINGS,
  isExportTarget,
  isTheme,
  SOURCE_URL,
  type AboutInfo,
  type ExportNames,
  type ExportOutcome,
  type PreviewPatch,
  type Settings,
} from '../shared/ipc';
import { opHasAddedArea, type MosaicOp, type Rect } from '../shared/types';
import { parseVersion } from '../shared/version';
import { chooseEditPath, type WrittenEdit } from './edit-path';
import { Limiter, WorkerClient } from './pool';
import { parseNotices } from './notices';
import { Session } from './session';
import { onScreen } from './window-state';
import { readSettings, writeSettings } from './settings';
import { createUpdateService } from './updates';
import { UpdateService } from './update-sources';

declare const __APP_VERSION__: string;

const MODEL_FILE = 'face_detection_yunet_2026may.onnx';
const PARTITION = 'pixlad'; // no "persist:" prefix: Chromium keeps nothing on disk for it

app.setName('Pixlad');
protocol.registerSchemesAsPrivileged([
  { scheme: 'pixlad', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/**
 * A file shipped with the app: in a packaged build it is in the resources folder, from the source
 * tree it is found by walking up from the bundle to `fromSource` (relative to the project root).
 */
function shippedFile(packaged: string, fromSource: string): string {
  const inResources = join(process.resourcesPath ?? '', packaged);
  // A packaged app looks nowhere else; a walk up from the bundle could find a copy in a source
  // tree around it and hide a file that is missing from the package.
  if (app.isPackaged || existsSync(inResources)) return inResources;
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    const candidate = join(dir, fromSource);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return join(app.getAppPath(), fromSource);
  }
}

/** The app icon: the title bar and taskbar on Windows and Linux, the Dock when run from source. */
const iconPath = (): string => shippedFile('icon.png', join('build', 'icon.png'));

const modelPath = (): string =>
  shippedFile(join('models', MODEL_FILE), join('resources', 'models', MODEL_FILE));

/**
 * Electron ships Chromium's licences next to its executable. electron-builder leaves them there on
 * Windows and Linux and moves them into Contents/Resources on macOS, where the bundle has no other
 * place for them.
 */
function chromiumLicensesPath(): string | undefined {
  const exe = dirname(process.execPath);
  return [exe, join(exe, '..', 'Resources'), join(exe, '..', '..', '..')]
    .map((dir) => join(dir, 'LICENSES.chromium.html'))
    .find((path) => existsSync(path));
}

const session = new Session();
const written = new Map<string, WrittenEdit>(); // by source path; this run only, never saved
let settings: Settings = { ...DEFAULT_SETTINGS };
let unexported = 0;
let forceClose = false;
let updates: UpdateService;

let photoWorker: WorkerClient;
let exportWorker: WorkerClient;
let thumbWorker: WorkerClient;
const thumbLimiter = new Limiter(1);
const thumbCache = new Map<string, Buffer>(); // small PNGs, bounded, in memory only
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json');
const THUMB_CACHE_MAX = 400;

let settingsWrites: Promise<unknown> = Promise.resolve();

/** Applies at once. A failed write only means the change is forgotten at the next start. */
function changeSettings(change: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...change };
  const snapshot = settings;
  const write = settingsWrites.then(() => writeSettings(settingsFile(), snapshot));
  settingsWrites = write.catch(() => undefined);
  return write;
}

// Everything that touches the current photo goes through one chain, so an "open" that was
// superseded by a later one is skipped instead of decoding a photo nobody is looking at.
let photoChain: Promise<unknown> = Promise.resolve();
let wantedId: string | undefined;
let openId: string | undefined;

function onPhoto<T>(id: string, job: () => Promise<T>): Promise<T> {
  const next = photoChain.then(async () => {
    const photo = session.get(id);
    if (!photo) throw new Error('that photo is no longer in the session');
    if (openId !== id) {
      if (wantedId !== id) throw new Error('another photo was opened meanwhile');
      openId = undefined;
      await photoWorker.run({ type: 'open', path: photo.path });
      openId = id;
    }
    return job();
  });
  photoChain = next.catch(() => undefined);
  return next;
}

/** The window's own colour, matching --bg, so it never flashes the other theme while loading. */
const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? '#0e0e0f' : '#ececea');

/**
 * Light or dark for the native parts and, through prefers-color-scheme, for the page. 'system'
 * hands the choice back to the operating system.
 */
function applyTheme(): void {
  nativeTheme.themeSource = settings.theme;
}

function createWindow(): BrowserWindow {
  // The first start opens maximized. After that the window opens the way it was left.
  const saved = onScreen(
    settings.window,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const window = new BrowserWindow({
    ...(saved
      ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      : { width: 1440, height: 900 }),
    // Shown once maximized, so it never flashes at the smaller size first.
    show: false,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: windowBackground(),
    title: 'Pixlad',
    // macOS takes the icon from the app bundle and ignores this.
    icon: iconPath(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  window.once('ready-to-show', () => {
    if (!saved || saved.maximized) window.maximize();
    window.show();
  });

  let saveTimer: NodeJS.Timeout | undefined;
  const saveState = (): void => {
    clearTimeout(saveTimer);
    if (window.isDestroyed() || window.isMinimized()) return;
    const bounds = window.getNormalBounds();
    void changeSettings({
      window: { ...bounds, maximized: window.isMaximized() || window.isFullScreen() },
    }).catch((cause: unknown) => console.warn('Could not save the window state:', cause));
  };
  const saveSoon = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    window.on(event as 'resize', saveSoon);
  }
  window.on('close', saveState);

  const onThemeChange = (): void => window.setBackgroundColor(windowBackground());
  nativeTheme.on('updated', onThemeChange);
  window.on('closed', () => nativeTheme.off('updated', onThemeChange));

  window.on('close', (event) => {
    if (forceClose || unexported === 0) return;
    event.preventDefault();
    void dialog
      .showMessageBox(window, {
        type: 'question',
        buttons: ['Close anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `${unexported} ${unexported === 1 ? 'photo has' : 'photos have'} unexported mosaics. Close anyway?`,
      })
      .then((result) => {
        if (result.response === 0) {
          forceClose = true;
          window.close();
        }
      });
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return window;
}

function registerIpc(): void {
  ipcMain.handle('dialog:open', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: 'JPEG', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'] }],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('session:add', (_e, paths: string[]) => session.add(paths));
  ipcMain.handle('session:remove', (_e, id: string) => {
    session.remove(id);
    thumbCache.delete(id);
    if (openId === id) openId = undefined;
  });
  ipcMain.handle('photo:open', async (_e, id: string) => {
    wantedId = id;
    await onPhoto(id, async () => undefined);
  });
  ipcMain.handle(
    'photo:preview',
    async (_e, id: string, op: MosaicOp): Promise<PreviewPatch | null> => {
      wantedId = id;
      return onPhoto(id, () => photoWorker.run<PreviewPatch | null>({ type: 'preview', op }));
    },
  );
  ipcMain.handle('photo:detect', async (_e, id: string, region: Rect) => {
    wantedId = id;
    return onPhoto(id, () => photoWorker.run({ type: 'detect', region }));
  });
  ipcMain.handle('photo:export', async (_e, id: string, op: MosaicOp): Promise<ExportOutcome> => {
    const photo = session.get(id);
    if (!photo) return { ok: false, message: 'That photo is no longer in the session.' };
    if (!opHasAddedArea(op))
      return { ok: false, message: `${photo.name}: there is no mosaic to export` };
    const target = settings.exportTarget;
    try {
      const result = await exportWorker.run<{
        path: string;
        replaced: boolean;
        written: WrittenEdit;
      }>({
        type: 'export',
        request: {
          sourcePath: photo.path,
          op,
          target,
          written: written.get(photo.path),
          protectedPaths: [...session.sourcePaths()],
        },
      });
      const overwrote = target === 'overwrite';
      if (overwrote) {
        // The decoded pixels and the thumbnail are of the file that was just replaced.
        thumbCache.delete(id);
        if (openId === id) openId = undefined;
      } else {
        written.set(photo.path, result.written);
      }
      return {
        ok: true,
        path: result.path,
        name: result.path.split(/[\\/]/).pop()!,
        replaced: result.replaced,
        overwrote,
      };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  });
  ipcMain.handle('about:info', async (): Promise<AboutInfo> => {
    const [license, notices] = await Promise.all([
      readFile(shippedFile('LICENSE', 'LICENSE'), 'utf8'),
      readFile(shippedFile('THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    ]);
    return {
      version: __APP_VERSION__,
      license,
      notices: parseNotices(notices),
      hasChromiumLicenses: chromiumLicensesPath() !== undefined,
      canCheckForUpdates: updates.enabled,
    };
  });
  ipcMain.handle('about:chromium-licenses', async () => {
    const path = chromiumLicensesPath();
    if (!path) throw new Error('Could not find the Chromium licence file');
    const failure = await shell.openPath(path);
    if (failure) throw new Error(failure);
  });
  // A fixed URL: the page never chooses what is opened.
  ipcMain.handle('about:source', () => shell.openExternal(SOURCE_URL));
  ipcMain.handle('update:open-notes', (_e, version: unknown) => {
    if (typeof version !== 'string' || !parseVersion(version)) throw new Error('Unknown version');
    return shell.openExternal(`${SOURCE_URL}/releases/tag/v${version}`);
  });
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('export:names', async (_e, id: string): Promise<ExportNames> => {
    const photo = session.get(id);
    if (!photo) throw new Error('That photo is no longer in the session.');
    const copy = await chooseEditPath(photo.path, written.get(photo.path), session.sourcePaths());
    return { source: photo.name, copy: basename(copy.path) };
  });
  ipcMain.handle('settings:set-export-target', async (_e, target: unknown) => {
    if (!isExportTarget(target)) throw new Error('Unknown export target');
    await changeSettings({ exportTarget: target, exportChosen: true });
  });
  ipcMain.handle('settings:set-check-for-updates', async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Unknown value for the update check');
    await changeSettings({ checkForUpdates: enabled });
  });
  ipcMain.handle('settings:set-theme', async (_e, theme: unknown) => {
    if (!isTheme(theme)) throw new Error('Unknown theme');
    // Switched before the write, so a failed save still changes the look until the next start.
    const write = changeSettings({ theme });
    applyTheme();
    await write;
  });
  ipcMain.handle('update:check-on-start', () =>
    settings.checkForUpdates && updates.enabled ? updates.check() : undefined,
  );
  ipcMain.handle('update:check', () => updates.check());
  ipcMain.handle('update:download', (event) =>
    updates.download((percent) => {
      if (!event.sender.isDestroyed()) event.sender.send('update:progress', percent);
    }),
  );
  ipcMain.handle('update:install', async (event) => {
    if (unexported > 0) {
      const options = {
        type: 'question' as const,
        buttons: ['Restart anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `${unexported} ${unexported === 1 ? 'photo has' : 'photos have'} unexported mosaics. Restart anyway?`,
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 0) return;
    }
    // The close question was just answered.
    forceClose = true;
    updates.install();
  });
  ipcMain.on('session:unexported', (_e, count: number) => {
    unexported = Number.isFinite(count) ? count : 0;
  });
}

function registerProtocol(): void {
  const ses = electronSession.fromPartition(PARTITION);
  ses.protocol.handle('pixlad', async (request) => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\//, '');
    const photo = session.get(id);
    if (!photo) return new Response('not found', { status: 404 });
    const headers = { 'Cache-Control': 'no-store' };
    if (url.hostname === 'photo') {
      // The original bytes: Chromium decodes them with their own profile and orientation.
      const { net } = await import('electron');
      const response = await net.fetch(pathToFileURL(photo.path).toString());
      return new Response(response.body, {
        status: response.status,
        headers: { ...headers, 'Content-Type': 'image/jpeg' },
      });
    }
    if (url.hostname === 'thumb') {
      try {
        let png = thumbCache.get(id);
        if (!png) {
          png = await thumbLimiter.run(() =>
            thumbWorker.run<Buffer>({ type: 'thumb', path: photo.path }),
          );
          png = Buffer.from(png);
          thumbCache.set(id, png);
          if (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value!);
        }
        return new Response(new Uint8Array(png), {
          headers: { ...headers, 'Content-Type': 'image/png' },
        });
      } catch {
        return new Response('thumbnail failed', { status: 500 });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

app.whenReady().then(async () => {
  // A packaged macOS app has the icon in its bundle; run from source, the Dock shows Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconPath());
  // macOS keeps its menu: it sits outside the window and carries Quit and Copy/Paste.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  settings = await readSettings(settingsFile());
  applyTheme();
  try {
    updates = createUpdateService();
  } catch (cause) {
    // Updates are optional: a failure here must never keep the window from opening.
    console.warn('Could not set up update checks:', cause);
    updates = new UpdateService(undefined);
  }
  const workerFile = new URL('./worker.js', import.meta.url);
  photoWorker = new WorkerClient(workerFile, modelPath());
  exportWorker = new WorkerClient(workerFile, modelPath());
  thumbWorker = new WorkerClient(workerFile, modelPath());
  registerProtocol();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
// A quit can land between a settings change and its write, and closing the window saves its
// size on the way out. Hold the quit until the write queue is empty, so the last change is saved.
// This waits in will-quit, not before-quit: only by then are the windows closed and their writes
// queued.
let settingsSaved = false;
app.on('will-quit', (event) => {
  if (!settingsSaved) {
    event.preventDefault();
    void settingsWrites.finally(() => {
      settingsSaved = true;
      app.quit();
    });
    return;
  }
  void photoWorker?.terminate();
  void exportWorker?.terminate();
  void thumbWorker?.terminate();
});
