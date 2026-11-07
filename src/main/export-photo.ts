import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { renderMosaic } from '../shared/mosaic';
import type { MosaicOp } from '../shared/types';
import { chooseEditPath, type WrittenEdit } from './edit-path';
import { decodeCoefficients } from './jpeg/decode';
import { encodeCoefficients } from './jpeg/encode';
import { scrubSegments } from './jpeg/metadata';
import { iccProfile } from './jpeg/parse';
import { decodePlanes, planesToRgba } from './jpeg/pixels';
import { inspectJpegPreviews, EmbeddedPreviewError } from './jpeg/previews';
import { applyPatchToCoefficients } from './jpeg/recode';

export interface ExportRequest {
  sourcePath: string;
  op: MosaicOp;
  /** The file this session wrote for this source earlier, if any. */
  written?: WrittenEdit | undefined;
  /** Other sources of the session, never overwritten. */
  protectedPaths?: readonly string[];
}

export interface ExportResult {
  path: string;
  bytes: number;
  replaced: boolean;
  written: WrittenEdit;
  /** Blocks re-encoded, and what was removed from the metadata. */
  blocksRewritten: number;
  removed: string[];
}

/** An export that failed in a way the user can act on; the message names the file or folder. */
export class ExportFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExportFailure';
  }
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && Buffer.compare(a, b) === 0);

/**
 * Write `<name>_edit.jpg` next to the source: the source's coefficients with the mosaic blocks
 * re-encoded, its metadata with thumbnails and previews removed, its modification time. The
 * source is only ever read.
 */
export async function exportEdit(request: ExportRequest): Promise<ExportResult> {
  const { sourcePath, op } = request;
  const name = basename(sourcePath);
  const folder = dirname(sourcePath);

  let source: Buffer;
  let sourceStat;
  try {
    source = await readFile(sourcePath);
    sourceStat = await stat(sourcePath);
  } catch (cause) {
    throw new ExportFailure(`${name}: cannot read the source file (${errorText(cause)})`, {
      cause,
    });
  }

  const decoded = decodeCoefficients(source);
  const { frame, orientation } = decoded.header;
  const swap = orientation >= 5;
  const planes = decodePlanes(decoded);
  const patch = renderMosaic(
    planesToRgba(decoded, planes),
    swap ? frame.height : frame.width,
    swap ? frame.width : frame.height,
    op,
  );
  if (!patch) throw new ExportFailure(`${name}: there is no mosaic to export`);

  const blocksRewritten = applyPatchToCoefficients(decoded, planes, patch);
  const scrubbed = scrubSegments(decoded.header.segments);
  const bytes = encodeCoefficients(decoded, scrubbed.segments);

  const target = await chooseEditPath(sourcePath, request.written, new Set(request.protectedPaths));
  const temp = `${target.path}.${randomUUID()}.tmp`;
  try {
    let handle;
    try {
      handle = await open(temp, 'wx');
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new ExportFailure(
          `${name}: cannot save in ${folder} because the folder is read-only or not writable`,
          { cause },
        );
      }
      throw new ExportFailure(`${name}: cannot save in ${folder} (${errorText(cause)})`, { cause });
    }
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await utimes(temp, sourceStat.atimeMs / 1000, sourceStat.mtimeMs / 1000);

    // Verify the bytes that were written, not the ones in memory.
    const written = await readFile(temp);
    const findings = inspectJpegPreviews(written);
    if (findings.length > 0) throw new EmbeddedPreviewError(name, findings);
    const check = decodeCoefficients(written);
    const same = decoded.components.every((c, i) => {
      const other = check.components[i]!;
      return (
        c.coeffs.length === other.coeffs.length &&
        Buffer.compare(Buffer.from(c.coeffs.buffer), Buffer.from(other.coeffs.buffer)) === 0
      );
    });
    if (!same) throw new ExportFailure(`${name}: the written file does not match what was encoded`);
    if (!sameBytes(iccProfile(decoded.header.segments), iccProfile(check.header.segments))) {
      throw new ExportFailure(`${name}: the colour profile changed while writing`);
    }

    await rename(temp, target.path);
    const info = await stat(target.path);
    return {
      path: target.path,
      bytes: info.size,
      replaced: target.replace,
      written: { path: target.path, size: info.size, mtimeMs: info.mtimeMs },
      blocksRewritten,
      removed: scrubbed.removed,
    };
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
