// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session as electronSession,
} from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isExportTarget,
  type ExportOutcome,
  type ExportTarget,
  type PreviewPatch,
} from '../shared/ipc';
import { opHasAddedArea, type MosaicOp, type Rect } from '../shared/types';
import type { WrittenEdit } from './edit-path';
import { Limiter, WorkerClient } from './pool';
import { Session } from './session';
import { readExportTarget, writeExportTarget } from './settings';

const MODEL_FILE = 'face_detection_yunet_2026may.onnx';
const PARTITION = 'mosaic-retouch'; // no "persist:" prefix: Chromium keeps nothing on disk for it

app.setName('Mosaic Retouch');
protocol.registerSchemesAsPrivileged([
  { scheme: 'mr', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** `resources/models/` next to the app: found by walking up from the bundle, or in a packaged build. */
function modelPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'models', MODEL_FILE);
  if (existsSync(packaged)) return packaged;
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    const candidate = join(dir, 'resources', 'models', MODEL_FILE);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return join(app.getAppPath(), 'resources', 'models', MODEL_FILE);
  }
}

const session = new Session();
const written = new Map<string, WrittenEdit>(); // by source path; this run only, never saved
let exportTarget: ExportTarget = 'suffix';
let unexported = 0;
let forceClose = false;

let photoWorker: WorkerClient;
let exportWorker: WorkerClient;
let thumbWorker: WorkerClient;
const thumbLimiter = new Limiter(1);
const thumbCache = new Map<string, Buffer>(); // small PNGs, bounded, in memory only
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json');
const THUMB_CACHE_MAX = 400;

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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0e0e0f',
    title: 'Mosaic Retouch',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);

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
    const target = exportTarget;
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
  ipcMain.handle(
    'dialog:remove-exported',
    async (event, count: number, name: string | undefined): Promise<boolean> => {
      const options = {
        type: 'question' as const,
        buttons: ['Remove', 'Keep'],
        defaultId: 0,
        cancelId: 1,
        message:
          count === 1 && name
            ? `Remove ${name} from the session?`
            : `Remove ${count} exported photos from the session?`,
        detail: 'Files on disk are not deleted.',
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
  );
  ipcMain.handle('settings:export-target', () => exportTarget);
  ipcMain.handle('settings:set-export-target', async (_e, target: unknown) => {
    if (!isExportTarget(target)) throw new Error('Unknown export target');
    // Applies at once; a failed write only means it is forgotten at the next start.
    exportTarget = target;
    await writeExportTarget(settingsFile(), target);
  });
  ipcMain.on('session:unexported', (_e, count: number) => {
    unexported = Number.isFinite(count) ? count : 0;
  });
}

function registerProtocol(): void {
  const ses = electronSession.fromPartition(PARTITION);
  ses.protocol.handle('mr', async (request) => {
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
  // macOS keeps its menu: it sits outside the window and carries Quit and Copy/Paste.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  exportTarget = await readExportTarget(settingsFile());
  const workerFile = new URL('./worker.js', import.meta.url);
  photoWorker = new WorkerClient(workerFile, modelPath());
  exportWorker = new WorkerClient(workerFile, modelPath());
  thumbWorker = new WorkerClient(workerFile, modelPath());
  registerProtocol();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  void photoWorker?.terminate();
  void exportWorker?.terminate();
  void thumbWorker?.terminate();
});
