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
  confirmRemoveExported: (count, name) => ipcRenderer.invoke('dialog:remove-exported', count, name),
  exportTarget: () => ipcRenderer.invoke('settings:export-target'),
  setExportTarget: (target) => ipcRenderer.invoke('settings:set-export-target', target),
  about: () => ipcRenderer.invoke('about:info'),
  openChromiumLicenses: () => ipcRenderer.invoke('about:chromium-licenses'),
  openSource: () => ipcRenderer.invoke('about:source'),
  setUnexported: (count) => ipcRenderer.send('session:unexported', count),
};

contextBridge.exposeInMainWorld('api', api);
