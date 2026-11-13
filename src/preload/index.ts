// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api } from '../shared/ipc';

const api: Api = {
  pathsForFiles: (files) =>
    files.map((file) => webUtils.getPathForFile(file)).filter((p) => p !== ''),
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  addPaths: (paths) => ipcRenderer.invoke('session:add', paths),
  removePhoto: (id) => ipcRenderer.invoke('session:remove', id),
  openPhoto: (id) => ipcRenderer.invoke('photo:open', id),
  preview: (id, op) => ipcRenderer.invoke('photo:preview', id, op),
  detect: (id, region) => ipcRenderer.invoke('photo:detect', id, region),
  exportPhoto: (id, op) => ipcRenderer.invoke('photo:export', id, op),
  settings: () => ipcRenderer.invoke('settings:get'),
  exportNames: (id) => ipcRenderer.invoke('export:names', id),
  setExportTarget: (target) => ipcRenderer.invoke('settings:set-export-target', target),
  setCheckForUpdates: (enabled) => ipcRenderer.invoke('settings:set-check-for-updates', enabled),
  setTheme: (theme) => ipcRenderer.invoke('settings:set-theme', theme),
  about: () => ipcRenderer.invoke('about:info'),
  openChromiumLicenses: () => ipcRenderer.invoke('about:chromium-licenses'),
  openSource: () => ipcRenderer.invoke('about:source'),
  checkForUpdatesOnStart: () => ipcRenderer.invoke('update:check-on-start'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleaseNotes: (version) => ipcRenderer.invoke('update:open-notes', version),
  onUpdateProgress: (listener) => {
    const handler = (_event: unknown, percent: number | undefined): void => listener(percent);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
  setUnexported: (count) => ipcRenderer.send('session:unexported', count),
};

contextBridge.exposeInMainWorld('api', api);
