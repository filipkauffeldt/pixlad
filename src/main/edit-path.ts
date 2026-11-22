// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export interface WrittenEdit {
  path: string;
  size: number;
  mtimeMs: number;
}

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif']);
const MAX_EDIT_ATTEMPTS = 10_000;

export function editExtension(sourcePath: string): string {
  const ext = extname(sourcePath);
  return JPEG_EXTENSIONS.has(ext.toLowerCase()) ? ext : '.jpg';
}

export function editPath(sourcePath: string, attempt: number): string {
  const ext = extname(sourcePath);
  const base = basename(sourcePath, ext);
  const suffix = attempt <= 1 ? '_edit' : `_edit-${attempt}`;
  return join(dirname(sourcePath), `${base}${suffix}${editExtension(sourcePath)}`);
}

async function statOrUndefined(
  path: string,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

async function isUnchanged(written: WrittenEdit): Promise<boolean> {
  const info = await statOrUndefined(written.path);
  return info?.size === written.size && info.mtimeMs === written.mtimeMs;
}

export async function chooseEditPath(
  sourcePath: string,
  written: WrittenEdit | undefined,
  protectedPaths: ReadonlySet<string> = new Set(),
): Promise<{ path: string; replace: boolean }> {
  if (written && (await isUnchanged(written))) return { path: written.path, replace: true };
  for (let attempt = 1; attempt < MAX_EDIT_ATTEMPTS; attempt++) {
    const candidate = editPath(sourcePath, attempt);
    if (candidate === sourcePath || protectedPaths.has(candidate)) continue;
    if ((await statOrUndefined(candidate)) === undefined)
      return { path: candidate, replace: false };
  }
  throw new Error(`No free file name for the edit of ${basename(sourcePath)}`);
}
