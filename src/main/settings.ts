// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { readFile, writeFile } from 'node:fs/promises';
import { isExportTarget, type ExportTarget } from '../shared/ipc';

/**
 * The export target, the only thing kept between runs. Anything unreadable means `suffix`, so a
 * damaged file can never turn on overwriting.
 */
export async function readExportTarget(file: string): Promise<ExportTarget> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Could not read ${file}:`, cause);
    }
    return 'suffix';
  }
  try {
    const target = (JSON.parse(text) as { exportTarget?: unknown } | null)?.exportTarget;
    return isExportTarget(target) ? target : 'suffix';
  } catch (cause) {
    console.warn(`Could not parse ${file}:`, cause);
    return 'suffix';
  }
}

export async function writeExportTarget(file: string, target: ExportTarget): Promise<void> {
  await writeFile(file, JSON.stringify({ exportTarget: target }));
}
