// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { readFile } from 'node:fs/promises';
import {
  ADOBE_ID,
  ADOBE_SEGMENT_LENGTH,
  APP0,
  APP1,
  APP13_PHOTOSHOP,
  APP14,
  APP2,
  EOI,
  EXIF_ID,
  ICC_HEADER_LENGTH,
  ICC_ID,
  IFD_ENTRY_SIZE,
  IRB_MIN_BLOCK_SIZE,
  IRB_SIGNATURE,
  IRB_THUMBNAIL_RESOURCE_IDS,
  IRB_XMP_RESOURCE_ID,
  JFIF_HEADER_LENGTH,
  JFIF_ID,
  JFIF_THUMBNAIL_HEIGHT_AT,
  JFIF_THUMBNAIL_WIDTH_AT,
  MARKER_PREFIX,
  MAX_IFD_ENTRIES,
  PHOTOSHOP_ID,
  RST0,
  RST7,
  SOI,
  SOS,
  TEM,
  TIFF_HEADER_LENGTH,
  TIFF_MAGIC,
  TIFF_TAG,
  TIFF_TYPE,
  TIFF_TYPE_SIZE,
  XMP_EXTENDED_ID,
  XMP_STANDARD_ID,
  appNumber,
  isAppMarker,
} from './parse';

// Ported from editing-experiment packages/export (GPL-3.0-or-later).

export type PreviewFindingKind =
  | 'exif-ifd1'
  | 'exif-thumbnail-tags'
  | 'exif-jpgfromraw'
  | 'exif-previewimage'
  | 'exif-embedded-jpeg'
  | 'photoshop-thumbnail'
  | 'xmp-thumbnail'
  | 'jfif-thumbnail'
  | 'unexpected-app'
  | 'unexpected-app0'
  | 'unexpected-app2'
  | 'unexpected-app13'
  | 'malformed-app'
  | 'malformed-exif'
  | 'malformed-photoshop'
  | 'malformed-jpeg'
  | 'trailing-data'
  | 'second-soi';

export interface PreviewFinding {
  kind: PreviewFindingKind;
  detail: string;
}

export class EmbeddedPreviewError extends Error {
  readonly findings: PreviewFinding[];

  constructor(path: string, findings: PreviewFinding[]) {
    const detail = findings.map((f) => f.detail).join(', ');
    super(`${path} was not saved because it still contains an embedded preview (${detail})`);
    this.name = 'EmbeddedPreviewError';
    this.findings = findings;
  }
}

const SOI_WORD = (MARKER_PREFIX << 8) | SOI;
const JPEG_STREAM_START = [MARKER_PREFIX, SOI, MARKER_PREFIX];
const MAX_VISITED_IFDS = 64;
const MAX_OFFSET_VALUES = 64;

const EXIF_HEADER = Buffer.from(EXIF_ID, 'latin1');
const ICC_HEADER = Buffer.from(ICC_ID, 'latin1');
const JFIF_HEADER = Buffer.from(JFIF_ID, 'latin1');
const ADOBE_HEADER = Buffer.from(ADOBE_ID, 'latin1');
const PHOTOSHOP_HEADER = Buffer.from(PHOTOSHOP_ID, 'latin1');

/** Allowlist: unknown APPn segments, malformed metadata, a second SOI or bytes after EOI fail. */
export function inspectJpegPreviews(data: Uint8Array): PreviewFinding[] {
  const findings: PreviewFinding[] = [];

  if (data.length < 4 || readU16BE(data, 0) !== SOI_WORD) {
    throw new Error('Not a JPEG file (missing SOI marker)');
  }

  const secondSoi = indexOfBytes(data, JPEG_STREAM_START, 2);
  if (secondSoi >= 0) {
    findings.push({ kind: 'second-soi', detail: `second SOI at offset ${secondSoi}` });
  }

  let offset = 2;
  let terminated = false;
  while (offset < data.length) {
    if (data[offset] !== MARKER_PREFIX) {
      findings.push({ kind: 'malformed-jpeg', detail: `expected marker at offset ${offset}` });
      break;
    }
    while (offset < data.length && data[offset] === MARKER_PREFIX) offset++;
    if (offset >= data.length) {
      findings.push({ kind: 'malformed-jpeg', detail: 'truncated marker' });
      break;
    }
    const marker = data[offset]!;
    offset++;

    if (marker === EOI) {
      terminated = true;
      if (offset < data.length) {
        findings.push({
          kind: 'trailing-data',
          detail: `${data.length - offset} byte(s) after EOI`,
        });
      }
      break;
    }
    if (marker === TEM || (marker >= RST0 && marker <= RST7)) continue;

    if (offset + 2 > data.length) {
      findings.push({ kind: 'malformed-jpeg', detail: 'truncated segment header' });
      break;
    }
    const length = readU16BE(data, offset);
    if (length === undefined || length < 2 || offset + length > data.length) {
      findings.push({ kind: 'malformed-jpeg', detail: 'truncated segment' });
      break;
    }
    const payload = data.subarray(offset + 2, offset + length);
    offset += length;

    if (isAppMarker(marker)) inspectAppSegment(marker, payload, findings);

    if (marker === SOS) {
      const eoi = findEoi(data, offset);
      if (eoi < 0) {
        findings.push({ kind: 'malformed-jpeg', detail: 'missing EOI' });
      } else {
        terminated = true;
        if (eoi + 2 < data.length) {
          findings.push({
            kind: 'trailing-data',
            detail: `${data.length - (eoi + 2)} byte(s) after EOI`,
          });
        }
      }
      break;
    }
  }

  if (!terminated && findings.length === 0) {
    findings.push({ kind: 'malformed-jpeg', detail: 'no EOI marker' });
  }

  return dedupe(findings);
}

export async function findEmbeddedPreviews(jpegPath: string): Promise<PreviewFinding[]> {
  const data = await readFile(jpegPath);
  return inspectJpegPreviews(data);
}

export async function assertNoEmbeddedPreviews(jpegPath: string): Promise<void> {
  const findings = await findEmbeddedPreviews(jpegPath);
  if (findings.length > 0) throw new EmbeddedPreviewError(jpegPath, findings);
}

function inspectAppSegment(marker: number, payload: Uint8Array, findings: PreviewFinding[]): void {
  if (marker === APP0) {
    inspectJfif(payload, findings);
    return;
  }
  if (marker === APP1) {
    inspectApp1(payload, findings);
    return;
  }
  if (marker === APP2) {
    inspectApp2(payload, findings);
    return;
  }
  if (marker === APP13_PHOTOSHOP) {
    inspectApp13(payload, findings);
    return;
  }
  if (
    marker === APP14 &&
    startsWith(payload, ADOBE_HEADER) &&
    payload.length === ADOBE_SEGMENT_LENGTH
  ) {
    return;
  }
  findings.push({
    kind: 'unexpected-app',
    detail: `APP${appNumber(marker)} segment is not part of the export allowlist`,
  });
}

function inspectJfif(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (!startsWith(payload, JFIF_HEADER)) {
    findings.push({
      kind: 'unexpected-app0',
      detail: 'APP0 is not JFIF (JFXX and vendor APP0 blocks may carry previews)',
    });
    return;
  }
  if (payload.length < JFIF_HEADER_LENGTH) {
    findings.push({ kind: 'malformed-app', detail: 'truncated JFIF header' });
    return;
  }
  const thumbnailWidth = payload[JFIF_THUMBNAIL_WIDTH_AT]!;
  const thumbnailHeight = payload[JFIF_THUMBNAIL_HEIGHT_AT]!;
  if (thumbnailWidth !== 0 || thumbnailHeight !== 0) {
    findings.push({
      kind: 'jfif-thumbnail',
      detail: `JFIF thumbnail ${thumbnailWidth}x${thumbnailHeight}`,
    });
    return;
  }
  if (payload.length !== JFIF_HEADER_LENGTH) {
    findings.push({ kind: 'malformed-app', detail: 'unexpected data after JFIF header' });
  }
}

function inspectApp2(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (!startsWith(payload, ICC_HEADER)) {
    findings.push({
      kind: 'unexpected-app2',
      detail: 'APP2 is not an ICC profile (MPF and other APP2 blocks may carry previews)',
    });
    return;
  }
  if (payload.length < ICC_HEADER_LENGTH) {
    findings.push({ kind: 'malformed-app', detail: 'truncated ICC profile header' });
  }
}

function inspectApp1(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (startsWith(payload, EXIF_HEADER)) {
    inspectTiff(payload.subarray(EXIF_HEADER.length), findings);
    return;
  }
  const headerLength = xmpHeaderLength(payload);
  if (headerLength !== undefined) {
    inspectXmp(payload.subarray(headerLength), findings);
    return;
  }
  findings.push({
    kind: 'unexpected-app',
    detail: 'APP1 is neither EXIF nor XMP',
  });
}

function inspectApp13(payload: Uint8Array, findings: PreviewFinding[]): void {
  if (!startsWith(payload, PHOTOSHOP_HEADER)) {
    findings.push({
      kind: 'unexpected-app13',
      detail: 'APP13 is not a Photoshop IRB',
    });
    return;
  }
  inspectPhotoshopIrbs(payload.subarray(PHOTOSHOP_HEADER.length), findings);
}

function inspectTiff(tiff: Uint8Array, findings: PreviewFinding[]): void {
  if (tiff.length < TIFF_HEADER_LENGTH) {
    findings.push({ kind: 'malformed-exif', detail: 'truncated TIFF header' });
    return;
  }
  const byteOrder = latin1(tiff, 0, 2);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') {
    findings.push({ kind: 'malformed-exif', detail: `invalid TIFF byte order ${byteOrder}` });
    return;
  }

  const u16 = (at: number): number | undefined =>
    little ? readU16LE(tiff, at) : readU16BE(tiff, at);
  const u32 = (at: number): number | undefined =>
    little ? readU32LE(tiff, at) : readU32BE(tiff, at);

  if (u16(2) !== TIFF_MAGIC) {
    findings.push({ kind: 'malformed-exif', detail: 'invalid TIFF magic' });
    return;
  }
  const ifd0 = u32(4);
  if (ifd0 === undefined || ifd0 < TIFF_HEADER_LENGTH || ifd0 >= tiff.length) {
    findings.push({ kind: 'malformed-exif', detail: `invalid IFD0 offset ${String(ifd0)}` });
    return;
  }

  const visited = new Set<number>();
  const queue: { offset: number; thumbnailIfd: boolean; label: string }[] = [
    { offset: ifd0, thumbnailIfd: false, label: 'IFD0' },
  ];

  while (queue.length > 0) {
    if (visited.size >= MAX_VISITED_IFDS) {
      findings.push({ kind: 'malformed-exif', detail: 'too many IFDs' });
      return;
    }
    const current = queue.shift()!;
    if (visited.has(current.offset)) {
      findings.push({
        kind: 'malformed-exif',
        detail: `IFD cycle at TIFF offset ${current.offset}`,
      });
      continue;
    }
    visited.add(current.offset);

    if (current.thumbnailIfd) {
      findings.push({
        kind: 'exif-ifd1',
        detail: `${current.label} at TIFF offset ${current.offset}`,
      });
    }

    const count = u16(current.offset);
    if (count === undefined || count > MAX_IFD_ENTRIES) {
      findings.push({
        kind: 'malformed-exif',
        detail: `invalid entry count at TIFF offset ${current.offset}`,
      });
      continue;
    }
    const entriesStart = current.offset + 2;
    const nextOffsetAt = entriesStart + count * IFD_ENTRY_SIZE;
    if (nextOffsetAt + 4 > tiff.length) {
      findings.push({
        kind: 'malformed-exif',
        detail: `truncated ${current.label} at TIFF offset ${current.offset}`,
      });
      continue;
    }

    for (let index = 0; index < count; index++) {
      const entry = entriesStart + index * IFD_ENTRY_SIZE;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const valueCount = u32(entry + 4);
      if (tag === undefined || type === undefined || valueCount === undefined) {
        findings.push({
          kind: 'malformed-exif',
          detail: `truncated entry in ${current.label}`,
        });
        break;
      }

      if (
        tag === TIFF_TAG.JPEG_INTERCHANGE_FORMAT ||
        tag === TIFF_TAG.JPEG_INTERCHANGE_FORMAT_LENGTH
      ) {
        findings.push({
          kind: 'exif-thumbnail-tags',
          detail: `tag 0x${tag.toString(16)} in ${current.label}`,
        });
      }
      if (tag === TIFF_TAG.JPEG_FROM_RAW) {
        findings.push({ kind: 'exif-jpgfromraw', detail: `tag 0x002e in ${current.label}` });
      }
      if (tag === TIFF_TAG.PREVIEW_IMAGE) {
        findings.push({ kind: 'exif-previewimage', detail: `tag 0xc51b in ${current.label}` });
      }
      if (tag === TIFF_TAG.STRIP_OFFSETS || tag === TIFF_TAG.STRIP_BYTE_COUNTS) {
        if (current.thumbnailIfd) {
          findings.push({
            kind: 'exif-ifd1',
            detail: `strips in ${current.label} at TIFF offset ${current.offset}`,
          });
        }
      }
      if (tag === TIFF_TAG.EXIF_IFD || tag === TIFF_TAG.GPS_IFD || tag === TIFF_TAG.INTEROP_IFD) {
        const offsets = readOffsets(tiff, little, type, valueCount, entry);
        if (offsets === undefined || offsets.length === 0) {
          findings.push({
            kind: 'malformed-exif',
            detail: `invalid ${labelForTag(tag)} pointer`,
          });
          continue;
        }
        for (const target of offsets) {
          if (target < TIFF_HEADER_LENGTH || target >= tiff.length) {
            findings.push({
              kind: 'malformed-exif',
              detail: `${labelForTag(tag)} offset ${target} is out of range`,
            });
            continue;
          }
          queue.push({ offset: target, thumbnailIfd: false, label: labelForTag(tag) });
        }
      } else if (tag === TIFF_TAG.SUB_IFDS) {
        const offsets = readOffsets(tiff, little, type, valueCount, entry);
        if (offsets === undefined || offsets.length === 0) {
          findings.push({ kind: 'malformed-exif', detail: 'invalid SubIFD pointer' });
          continue;
        }
        for (const target of offsets) {
          if (target < TIFF_HEADER_LENGTH || target >= tiff.length) {
            findings.push({
              kind: 'malformed-exif',
              detail: `SubIFD offset ${target} is out of range`,
            });
            continue;
          }
          queue.push({ offset: target, thumbnailIfd: false, label: 'SubIFD' });
        }
      }
    }

    const next = u32(nextOffsetAt);
    if (next === undefined) {
      findings.push({ kind: 'malformed-exif', detail: 'truncated next-IFD pointer' });
      continue;
    }
    if (next !== 0) {
      if (next < TIFF_HEADER_LENGTH || next >= tiff.length) {
        findings.push({
          kind: 'malformed-exif',
          detail: `${current.label} next IFD offset ${next} is out of range`,
        });
      } else {
        queue.push({ offset: next, thumbnailIfd: true, label: 'IFD1' });
      }
    }
  }

  const embeddedAt = indexOfBytes(tiff, JPEG_STREAM_START, 0);
  if (embeddedAt >= 0) {
    findings.push({
      kind: 'exif-embedded-jpeg',
      detail: `JPEG stream at TIFF offset ${embeddedAt}`,
    });
  }
}

function readOffsets(
  tiff: Uint8Array,
  little: boolean,
  type: number,
  count: number,
  entry: number,
): number[] | undefined {
  const unit = TIFF_TYPE_SIZE[type];
  if (unit === undefined || count === 0 || count > MAX_OFFSET_VALUES) return undefined;
  const size = unit * count;
  let base: number;
  if (size <= 4) {
    base = entry + 8;
  } else {
    const offset = little ? readU32LE(tiff, entry + 8) : readU32BE(tiff, entry + 8);
    if (offset === undefined) return undefined;
    base = offset;
  }
  if (base + size > tiff.length) return undefined;

  const offsets: number[] = [];
  for (let index = 0; index < count; index++) {
    const at = base + index * unit;
    if (type === TIFF_TYPE.SHORT) {
      const value = little ? readU16LE(tiff, at) : readU16BE(tiff, at);
      if (value === undefined) return undefined;
      offsets.push(value);
    } else if (type === TIFF_TYPE.LONG || type === TIFF_TYPE.IFD) {
      const value = little ? readU32LE(tiff, at) : readU32BE(tiff, at);
      if (value === undefined) return undefined;
      offsets.push(value);
    } else {
      return undefined;
    }
  }
  return offsets;
}

function inspectPhotoshopIrbs(data: Uint8Array, findings: PreviewFinding[]): void {
  if (data.length === 0) {
    findings.push({ kind: 'malformed-photoshop', detail: 'empty Photoshop IRB' });
    return;
  }

  let offset = 0;
  while (offset < data.length) {
    if (offset + IRB_MIN_BLOCK_SIZE > data.length) {
      findings.push({
        kind: 'malformed-photoshop',
        detail: `truncated IRB block at offset ${offset}`,
      });
      return;
    }
    if (latin1(data, offset, offset + IRB_SIGNATURE.length) !== IRB_SIGNATURE) {
      findings.push({
        kind: 'malformed-photoshop',
        detail: `invalid IRB signature at offset ${offset}`,
      });
      return;
    }
    const resourceId = readU16BE(data, offset + 4);
    if (resourceId === undefined) {
      findings.push({ kind: 'malformed-photoshop', detail: 'truncated IRB resource id' });
      return;
    }
    const nameLength = data[offset + 6]!;
    const nameFieldLength = padToEven(1 + nameLength);
    const sizeAt = offset + 6 + nameFieldLength;
    const size = readU32BE(data, sizeAt);
    if (size === undefined) {
      findings.push({ kind: 'malformed-photoshop', detail: 'truncated IRB resource size' });
      return;
    }
    const dataAt = sizeAt + 4;
    if (dataAt + size > data.length) {
      findings.push({ kind: 'malformed-photoshop', detail: 'truncated IRB resource data' });
      return;
    }

    if (IRB_THUMBNAIL_RESOURCE_IDS.includes(resourceId)) {
      findings.push({
        kind: 'photoshop-thumbnail',
        detail: `IRB resource 0x${resourceId.toString(16)}`,
      });
    }
    if (resourceId === IRB_XMP_RESOURCE_ID) {
      inspectXmp(data.subarray(dataAt, dataAt + size), findings);
    }

    offset = dataAt + padToEven(size);
  }
}

function inspectXmp(body: Uint8Array, findings: PreviewFinding[]): void {
  const variants = [
    Buffer.from(body).toString('utf8'),
    Buffer.from(body).toString('utf16le'),
    decodeUtf16be(body),
  ];

  for (const text of variants) {
    const lower = text.toLowerCase();
    if (lower.includes('xmpgimg:image')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xmpGImg:image' });
    }
    if (lower.includes('xapgimg:image')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xapGImg:image' });
    }
    if (lower.includes('xmptng:image')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xmpTng:image' });
    }
    if (lower.includes('ns.adobe.com/xap/1.0/g/img/')) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'xmpGImg namespace' });
    }
    if (/:thumbnails[\s>]/i.test(text)) {
      findings.push({ kind: 'xmp-thumbnail', detail: 'Thumbnails property' });
    }
  }
}

const padToEven = (n: number): number => n + (n % 2);

function decodeUtf16be(body: Uint8Array): string {
  if (body.length < 2) return '';
  const even = body.length - (body.length % 2);
  const copy = Buffer.from(body.subarray(0, even));
  copy.swap16();
  return copy.toString('utf16le');
}

function xmpHeaderLength(payload: Uint8Array): number | undefined {
  const head = latin1(payload, 0, Math.min(payload.length, 64));
  if (head.startsWith(XMP_STANDARD_ID)) return XMP_STANDARD_ID.length + 1;
  if (head.startsWith(XMP_EXTENDED_ID)) return XMP_EXTENDED_ID.length + 1;
  return undefined;
}

function labelForTag(tag: number): string {
  if (tag === TIFF_TAG.EXIF_IFD) return 'ExifIFD';
  if (tag === TIFF_TAG.GPS_IFD) return 'GPSIFD';
  return 'InteropIFD';
}

function findEoi(data: Uint8Array, from: number): number {
  for (let index = from; index + 1 < data.length; index++) {
    if (data[index] === MARKER_PREFIX && data[index + 1] === EOI) return index;
  }
  return -1;
}

function indexOfBytes(data: Uint8Array, needle: readonly number[], from: number): number {
  for (let index = Math.max(0, from); index + needle.length <= data.length; index++) {
    let matches = true;
    for (let at = 0; at < needle.length; at++) {
      if (data[index + at] !== needle[at]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function dedupe(findings: PreviewFinding[]): PreviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.kind}\0${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

function latin1(data: Uint8Array, start: number, end: number): string {
  return Buffer.from(data.buffer, data.byteOffset + start, Math.max(0, end - start)).toString(
    'latin1',
  );
}

function readU16BE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > data.length) return undefined;
  return (data[offset]! << 8) | data[offset + 1]!;
}

function readU16LE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > data.length) return undefined;
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU32BE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > data.length) return undefined;
  return (
    data[offset]! * 0x1000000 +
    (data[offset + 1]! << 16) +
    (data[offset + 2]! << 8) +
    data[offset + 3]!
  );
}

function readU32LE(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > data.length) return undefined;
  return (
    data[offset]! +
    (data[offset + 1]! << 8) +
    (data[offset + 2]! << 16) +
    data[offset + 3]! * 0x1000000
  );
}
