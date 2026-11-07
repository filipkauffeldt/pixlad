import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/** A file this session wrote, remembered in memory only. */
export interface WrittenEdit {
  path: string;
  size: number;
  mtimeMs: number;
}

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif']);

/** The source's own extension (case kept) when it is a JPEG one, else `.jpg`. */
export function editExtension(sourcePath: string): string {
  const ext = extname(sourcePath);
  return JPEG_EXTENSIONS.has(ext.toLowerCase()) ? ext : '.jpg';
}

/** `<name>_edit<ext>`, or `<name>_edit-2<ext>` and up. Always next to the source. */
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

/**
 * Where to write the edit of `sourcePath`.
 *
 * - The first free of `_edit`, `_edit-2`, `_edit-3`, ... is used, so a file from an earlier
 *   session or any other file is never overwritten.
 * - A file this session wrote for the same source is replaced instead (`replace: true`), but
 *   only while it is still the very file written: same path, size and modification time.
 * - `protectedPaths` (the other sources of the session) are never targets.
 */
export async function chooseEditPath(
  sourcePath: string,
  written: WrittenEdit | undefined,
  protectedPaths: ReadonlySet<string> = new Set(),
): Promise<{ path: string; replace: boolean }> {
  if (written) {
    const info = await statOrUndefined(written.path);
    if (info && info.size === written.size && info.mtimeMs === written.mtimeMs) {
      return { path: written.path, replace: true };
    }
  }
  for (let attempt = 1; attempt < 10_000; attempt++) {
    const candidate = editPath(sourcePath, attempt);
    if (candidate === sourcePath || protectedPaths.has(candidate)) continue;
    if ((await statOrUndefined(candidate)) === undefined)
      return { path: candidate, replace: false };
  }
  throw new Error(`No free file name for the edit of ${basename(sourcePath)}`);
}
