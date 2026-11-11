// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { readFile, rename, writeFile } from 'node:fs/promises';
import { DEFAULT_SETTINGS, isExportTarget, type Settings } from '../shared/ipc';
import { isWindowState } from './window-state';

/**
 * The settings, the only thing kept between runs. Each value that is missing or unreadable falls
 * back to its default on its own, so a damaged file can never turn on overwriting and never
 * loses a good value next to a bad one.
 */
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
    // A file from before this setting existed holds an export target only once the user picked
    // one, so that counts as chosen.
    exportChosen:
      typeof parsed?.exportChosen === 'boolean'
        ? parsed.exportChosen
        : isExportTarget(parsed?.exportTarget),
    checkForUpdates:
      typeof parsed?.checkForUpdates === 'boolean'
        ? parsed.checkForUpdates
        : DEFAULT_SETTINGS.checkForUpdates,
    ...(isWindowState(parsed?.window) ? { window: parsed.window } : {}),
  };
}

/** Written next to the file and renamed over it, so a crash or kill mid-write keeps the old file. */
export async function writeSettings(file: string, settings: Settings): Promise<void> {
  const partial = `${file}.partial`;
  await writeFile(partial, JSON.stringify(settings));
  await rename(partial, file);
}
