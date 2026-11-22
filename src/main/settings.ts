// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  DEFAULT_SETTINGS,
  isAfterExport,
  isExportTarget,
  isTheme,
  type Settings,
} from '../shared/ipc';
import { isWindowState } from './window-state';

export async function readSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Could not read ${file}:`, cause);
    }
    return { ...DEFAULT_SETTINGS };
  }
  let parsed: {
    exportTarget?: unknown;
    exportChosen?: unknown;
    checkForUpdates?: unknown;
    theme?: unknown;
    afterExport?: unknown;
    window?: unknown;
  } | null;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (cause) {
    console.warn(`Could not parse ${file}:`, cause);
    return { ...DEFAULT_SETTINGS };
  }
  return {
    exportTarget: isExportTarget(parsed?.exportTarget)
      ? parsed.exportTarget
      : DEFAULT_SETTINGS.exportTarget,
    // Files from before `exportChosen` existed hold an export target only once the user picked one.
    exportChosen:
      typeof parsed?.exportChosen === 'boolean'
        ? parsed.exportChosen
        : isExportTarget(parsed?.exportTarget),
    checkForUpdates:
      typeof parsed?.checkForUpdates === 'boolean'
        ? parsed.checkForUpdates
        : DEFAULT_SETTINGS.checkForUpdates,
    theme: isTheme(parsed?.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
    afterExport: isAfterExport(parsed?.afterExport)
      ? parsed.afterExport
      : DEFAULT_SETTINGS.afterExport,
    ...(isWindowState(parsed?.window) ? { window: parsed.window } : {}),
  };
}

export async function writeSettings(file: string, settings: Settings): Promise<void> {
  // Renamed over the file, so a crash mid-write keeps the old one.
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify(settings));
  await rename(partial, file);
}
