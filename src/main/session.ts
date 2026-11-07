// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AddResult, PhotoInfo, Refusal } from '../shared/ipc';
import { JpegError } from './jpeg/errors';
import { looksLikeJpeg, parseHeader, summarize } from './jpeg/parse';

const JPEG_EXTENSION = /\.(jpe?g|jpe|jfif)$/i;

/** Read just enough of a file to parse its JPEG header; never the whole file. */
export async function readPhotoInfo(path: string, id: string): Promise<PhotoInfo> {
  const handle = await open(path, 'r');
  try {
    let size = 64 * 1024;
    for (;;) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      const data = buffer.subarray(0, bytesRead);
      if (!looksLikeJpeg(data)) throw new JpegError('not-jpeg', 'is not a JPEG file');
      try {
        const summary = summarize(parseHeader(data));
        return {
          id,
          path,
          name: basename(path),
          width: summary.orientedWidth,
          height: summary.orientedHeight,
        };
      } catch (cause) {
        const truncated =
          cause instanceof JpegError && cause.code === 'corrupt' && bytesRead === size;
        if (!truncated || size >= 8 * 1024 * 1024) throw cause;
        size *= 4;
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * The files to look at: dropped files as they are, and for a dropped folder the JPEG files
 * directly in it (not its subfolders), in name order.
 */
export async function expandPaths(
  paths: readonly string[],
): Promise<{ files: string[]; notes: Refusal[] }> {
  const files: string[] = [];
  const notes: Refusal[] = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      notes.push({ name: basename(path), reason: 'could not be read' });
      continue;
    }
    if (!info.isDirectory()) {
      files.push(path);
      continue;
    }
    const entries = await readdir(path, { withFileTypes: true });
    const jpegs = entries
      .filter((e) => e.isFile() && JPEG_EXTENSION.test(e.name))
      .map((e) => join(path, e.name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    files.push(...jpegs);
    if (entries.some((e) => e.isDirectory())) {
      notes.push({
        name: basename(path),
        reason: 'is a folder: only the JPEGs directly in it were added, not its subfolders',
      });
    }
  }
  return { files, notes };
}

/** The photos of this run. In memory only: nothing about it is written anywhere. */
export class Session {
  private readonly photos = new Map<string, PhotoInfo>();
  private readonly byPath = new Map<string, string>();
  private counter = 0;

  get(id: string): PhotoInfo | undefined {
    return this.photos.get(id);
  }

  sourcePaths(): Set<string> {
    return new Set(this.byPath.keys());
  }

  remove(id: string): void {
    const photo = this.photos.get(id);
    if (!photo) return;
    this.photos.delete(id);
    this.byPath.delete(photo.path);
  }

  async add(paths: readonly string[]): Promise<AddResult> {
    const { files, notes } = await expandPaths(paths);
    const photos: PhotoInfo[] = [];
    const rejected: Array<Refusal & { path: string }> = [];
    let duplicates = 0;
    // A few at a time: headers are small, so this is fast, and the window never waits on one read.
    const queue = [...files];
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        if (this.byPath.has(path)) {
          duplicates++;
          continue;
        }
        const id = String(++this.counter);
        try {
          const info = await readPhotoInfo(path, id);
          this.photos.set(id, info);
          this.byPath.set(path, id);
          photos.push(info);
        } catch (cause) {
          const reason =
            cause instanceof JpegError
              ? cause.message
              : `could not be read (${(cause as Error).message})`;
          rejected.push({ path, name: basename(path), reason });
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    // Keep the order the files were given in.
    const order = new Map(files.map((p, i) => [p, i]));
    photos.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
    rejected.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
    const refused: Refusal[] = [
      ...notes,
      ...rejected.map(({ name, reason }) => ({ name, reason })),
    ];
    return { photos, refused, duplicates };
  }
}
