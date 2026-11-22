// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import {
  ADOBE_ID,
  ADOBE_SEGMENT_LENGTH,
  APP0,
  APP1,
  APP13_PHOTOSHOP,
  APP14,
  APP2,
  appNumber,
  COM,
  DQT,
  EOI,
  EXIF_ID,
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
  isAppMarker,
  MARKER_PREFIX,
  MAX_IFD_ENTRIES,
  MPF_ID,
  PHOTOSHOP_ID,
  SOI,
  SOS,
  TIFF_BIG_ENDIAN,
  TIFF_HEADER_LENGTH,
  TIFF_LITTLE_ENDIAN,
  TIFF_MAGIC,
  TIFF_TAG,
  TIFF_TYPE,
  TIFF_TYPE_SIZE,
  XMP_EXTENDED_ID,
  XMP_STANDARD_ID,
  type Segment,
} from './parse';

export interface ScrubResult {
  segments: Segment[];
  removed: string[];
}

const latin1 = (b: Uint8Array, from = 0, to = b.length): string =>
  Buffer.from(b.buffer, b.byteOffset + from, to - from).toString('latin1');
const startsWith = (b: Uint8Array, text: string): boolean => latin1(b, 0, text.length) === text;
const padToEven = (n: number): number => n + (n % 2);

const MAX_VISITED_IFDS = 64;
const MAX_SUB_IFDS = 16;
const THUMBNAIL_TAGS: readonly number[] = [
  TIFF_TAG.JPEG_INTERCHANGE_FORMAT,
  TIFF_TAG.JPEG_INTERCHANGE_FORMAT_LENGTH,
];
const PREVIEW_TAGS: readonly number[] = [TIFF_TAG.JPEG_FROM_RAW, TIFF_TAG.PREVIEW_IMAGE];
const DOOMED_TAGS = new Set([...THUMBNAIL_TAGS, ...PREVIEW_TAGS]);
const SUB_IFD_POINTER_TAGS: readonly number[] = [
  TIFF_TAG.EXIF_IFD,
  TIFF_TAG.GPS_IFD,
  TIFF_TAG.INTEROP_IFD,
];

const extendedXmpHasThumbnail = (extended: readonly Segment[]): boolean =>
  extended.length > 0 &&
  /g\/img\/|GImg:image|:Thumbnails/i.test(extended.map((s) => latin1(s.payload)).join(''));

/** Allowlist: a segment not proven free of a preview of the original picture is dropped. */
export function scrubSegments(segments: readonly Segment[]): ScrubResult {
  const kept: Segment[] = [];
  const removed: string[] = [];
  const extended = segments.filter(
    (s) => s.marker === APP1 && startsWith(s.payload, XMP_EXTENDED_ID),
  );
  const extendedHasThumbnail = extendedXmpHasThumbnail(extended);

  for (const segment of segments) {
    const { marker, payload } = segment;
    if (marker === COM || marker === DQT) {
      kept.push(segment);
    } else if (marker === APP0) {
      if (startsWith(payload, JFIF_ID) && payload.length >= JFIF_HEADER_LENGTH) {
        const clean = payload.slice(0, JFIF_HEADER_LENGTH);
        clean[JFIF_THUMBNAIL_WIDTH_AT] = 0;
        clean[JFIF_THUMBNAIL_HEIGHT_AT] = 0;
        if (
          payload.length > JFIF_HEADER_LENGTH ||
          payload[JFIF_THUMBNAIL_WIDTH_AT] ||
          payload[JFIF_THUMBNAIL_HEIGHT_AT]
        ) {
          removed.push('JFIF thumbnail');
        }
        kept.push({ marker, payload: clean });
      } else removed.push('APP0 other than JFIF');
    } else if (marker === APP1) {
      if (startsWith(payload, EXIF_ID)) {
        const result = scrubExif(payload);
        removed.push(...result.removed);
        kept.push({ marker, payload: result.payload });
      } else if (startsWith(payload, XMP_STANDARD_ID)) {
        const head = XMP_STANDARD_ID.length + 1;
        const text = latin1(payload, head);
        const scrubbed = scrubXmp(text);
        if (scrubbed !== text) removed.push('XMP thumbnail');
        kept.push({
          marker,
          payload: Buffer.concat([
            Buffer.from(payload.subarray(0, head)),
            Buffer.from(scrubbed, 'latin1'),
          ]),
        });
      } else if (startsWith(payload, XMP_EXTENDED_ID)) {
        if (extendedHasThumbnail) {
          if (extended[0] === segment) removed.push('extended XMP (held a thumbnail)');
        } else kept.push(segment);
      } else removed.push('unknown APP1');
    } else if (marker === APP2) {
      if (startsWith(payload, ICC_ID)) kept.push(segment);
      else removed.push(startsWith(payload, MPF_ID) ? 'MPF (multi-picture)' : 'unknown APP2');
    } else if (marker === APP13_PHOTOSHOP) {
      const scrubbed = scrubIrb(payload);
      if (scrubbed) {
        if (scrubbed.removed.length > 0) removed.push(...scrubbed.removed);
        kept.push({ marker, payload: scrubbed.payload });
      } else removed.push('unreadable Photoshop resources');
    } else if (marker === APP14) {
      if (startsWith(payload, ADOBE_ID) && payload.length === ADOBE_SEGMENT_LENGTH)
        kept.push(segment);
      else removed.push('unknown APP14');
    } else if (isAppMarker(marker)) {
      removed.push(`APP${appNumber(marker)}`);
    }
  }
  return { segments: kept, removed: [...new Set(removed)] };
}

export function scrubXmp(text: string): string {
  return text
    .replace(/<(\w+):Thumbnails\b[^>]*>[\s\S]*?<\/\1:Thumbnails>/gi, '')
    .replace(/<(xmpGImg|xapGImg|xmpTNG|xmpTng):(\w+)\b[^>]*>[\s\S]*?<\/\1:\2>/g, '')
    .replace(/\s(xmpGImg|xapGImg|xmpTNG|xmpTng):\w+="[^"]*"/g, '')
    .replace(/\sxmlns:(xmpGImg|xapGImg|xmpTNG|xmpTng)="[^"]*"/g, '');
}

function scrubIrb(payload: Uint8Array): { payload: Uint8Array; removed: string[] } | undefined {
  if (!startsWith(payload, PHOTOSHOP_ID)) return undefined;
  const out: Buffer[] = [Buffer.from(PHOTOSHOP_ID, 'latin1')];
  const removed: string[] = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let at = PHOTOSHOP_ID.length;
  while (at < payload.length) {
    if (at + IRB_MIN_BLOCK_SIZE > payload.length) return undefined;
    if (latin1(payload, at, at + IRB_SIGNATURE.length) !== IRB_SIGNATURE) return undefined;
    const id = view.getUint16(at + 4);
    const nameLength = payload[at + 6]!;
    const nameField = padToEven(1 + nameLength);
    const sizeAt = at + 6 + nameField;
    if (sizeAt + 4 > payload.length) return undefined;
    const size = view.getUint32(sizeAt);
    const dataAt = sizeAt + 4;
    const end = dataAt + padToEven(size);
    if (dataAt + size > payload.length) return undefined;
    const data = payload.subarray(dataAt, dataAt + size);
    if (IRB_THUMBNAIL_RESOURCE_IDS.includes(id)) {
      removed.push('Photoshop thumbnail');
    } else if (id === IRB_XMP_RESOURCE_ID) {
      const scrubbed = Buffer.from(scrubXmp(latin1(data)), 'latin1');
      if (scrubbed.length !== data.length) removed.push('XMP thumbnail');
      out.push(resource(id, payload.subarray(at + 6, sizeAt), scrubbed));
    } else {
      out.push(Buffer.from(payload.subarray(at, Math.min(end, payload.length))));
    }
    at = end;
  }
  return { payload: Buffer.concat(out), removed };
}

function resource(id: number, nameField: Uint8Array, data: Buffer): Buffer {
  const head = Buffer.alloc(6);
  head.write(IRB_SIGNATURE, 0, 'latin1');
  head.writeUInt16BE(id, 4);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  return Buffer.concat([
    head,
    Buffer.from(nameField),
    size,
    data,
    Buffer.alloc(padToEven(data.length) - data.length),
  ]);
}

/** Blanks in place instead of deleting, so no offset inside the block shifts. */
export function scrubExif(payload: Uint8Array): { payload: Uint8Array; removed: string[] } {
  const out = Uint8Array.from(payload);
  const removed: string[] = [];
  const tiff = out.subarray(EXIF_ID.length);
  const little = tiff[0] === TIFF_LITTLE_ENDIAN;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (at: number): number =>
    at >= 0 && at + 2 <= tiff.length ? view.getUint16(at, little) : 0;
  const u32 = (at: number): number =>
    at >= 0 && at + 4 <= tiff.length ? view.getUint32(at, little) : 0;
  const set32 = (at: number, v: number): void => void view.setUint32(at, v, little);
  const set16 = (at: number, v: number): void => void view.setUint16(at, v, little);
  const isTiff =
    tiff.length >= TIFF_HEADER_LENGTH &&
    (tiff[0] === TIFF_LITTLE_ENDIAN || tiff[0] === TIFF_BIG_ENDIAN) &&
    u16(2) === TIFF_MAGIC;
  if (!isTiff) return { payload: out, removed };
  const zero = (from: number, length: number): void => {
    if (from >= 0 && length > 0 && from + length <= tiff.length) tiff.fill(0, from, from + length);
  };
  const visited = new Set<number>();
  const ifd0Offset = u32(4);

  const valueAt = (entry: number): number => {
    const type = u16(entry + 2);
    return type === TIFF_TYPE.SHORT ? u16(entry + 8) : u32(entry + 8);
  };

  const ifdEnd = (offset: number, count: number): number => offset + 2 + count * IFD_ENTRY_SIZE + 4;

  const walkIfd = (offset: number, isThumbnail: boolean): void => {
    if (offset < TIFF_HEADER_LENGTH || visited.has(offset) || visited.size > MAX_VISITED_IFDS)
      return;
    visited.add(offset);
    const count = u16(offset);
    if (count > MAX_IFD_ENTRIES || ifdEnd(offset, count) > tiff.length) return;
    const entries: Array<{ tag: number; at: number }> = [];
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * IFD_ENTRY_SIZE;
      entries.push({ tag: u16(at), at });
    }
    const thumbOffset = entries.find((e) => e.tag === TIFF_TAG.JPEG_INTERCHANGE_FORMAT);
    const thumbLength = entries.find((e) => e.tag === TIFF_TAG.JPEG_INTERCHANGE_FORMAT_LENGTH);
    if (thumbOffset && thumbLength) zero(valueAt(thumbOffset.at), valueAt(thumbLength.at));
    const stripOffsets = entries.find((e) => e.tag === TIFF_TAG.STRIP_OFFSETS);
    const stripCounts = entries.find((e) => e.tag === TIFF_TAG.STRIP_BYTE_COUNTS);
    if (
      isThumbnail &&
      stripOffsets &&
      stripCounts &&
      u32(stripOffsets.at + 4) === 1 &&
      u32(stripCounts.at + 4) === 1
    ) {
      zero(valueAt(stripOffsets.at), valueAt(stripCounts.at));
    }
    const next = u32(offset + 2 + count * IFD_ENTRY_SIZE);
    for (const e of entries) {
      if (SUB_IFD_POINTER_TAGS.includes(e.tag)) walkIfd(u32(e.at + 8), false);
      if (e.tag === TIFF_TAG.SUB_IFDS) {
        const n = u32(e.at + 4);
        const base = n * 4 <= 4 ? e.at + 8 : u32(e.at + 8);
        for (let i = 0; i < Math.min(n, MAX_SUB_IFDS); i++) walkIfd(u32(base + i * 4), false);
      }
    }
    for (const e of entries) {
      if (THUMBNAIL_TAGS.includes(e.tag)) removed.push('EXIF thumbnail');
      if (PREVIEW_TAGS.includes(e.tag) && TIFF_TYPE_SIZE[u16(e.at + 2)] !== undefined) {
        const size = TIFF_TYPE_SIZE[u16(e.at + 2)]! * u32(e.at + 4);
        if (size > 4) zero(u32(e.at + 8), size);
        removed.push('EXIF preview');
      }
    }
    const kept = entries.filter((e) => !DOOMED_TAGS.has(e.tag));
    if (kept.length !== entries.length) {
      const raw = Buffer.from(tiff.subarray(offset + 2, offset + 2 + count * IFD_ENTRY_SIZE));
      tiff.fill(0, offset, ifdEnd(offset, count));
      set16(offset, kept.length);
      kept.forEach((e, i) => {
        const from = e.at - offset - 2;
        Buffer.from(raw.subarray(from, from + IFD_ENTRY_SIZE)).copy(
          tiff,
          offset + 2 + i * IFD_ENTRY_SIZE,
        );
      });
      set32(offset + 2 + kept.length * IFD_ENTRY_SIZE, next);
    }
    if (next !== 0) {
      if (isThumbnail || offset === ifd0Offset) {
        walkIfd(next, true);
        const nextCount = u16(next);
        if (nextCount <= MAX_IFD_ENTRIES && ifdEnd(next, nextCount) <= tiff.length)
          tiff.fill(0, next, ifdEnd(next, nextCount));
        set32(offset + 2 + kept.length * IFD_ENTRY_SIZE, 0);
        removed.push('EXIF thumbnail');
      } else {
        walkIfd(next, true);
      }
    }
  };
  walkIfd(ifd0Offset, false);

  for (let at = 0; at + 3 < tiff.length; at++) {
    if (isJpegStreamStart(tiff, at)) {
      const end = jpegStreamEnd(tiff, at);
      zero(at, end - at);
      removed.push('JPEG preview inside EXIF');
      at = end;
    }
  }
  return { payload: out, removed: [...new Set(removed)] };
}

const isJpegStreamStart = (data: Uint8Array, at: number): boolean =>
  data[at] === MARKER_PREFIX && data[at + 1] === SOI && data[at + 2] === MARKER_PREFIX;

const isEoiAt = (data: Uint8Array, at: number): boolean =>
  data[at] === MARKER_PREFIX && data[at + 1] === EOI;

function jpegStreamEnd(data: Uint8Array, start: number): number {
  let pos = start + 2;
  while (pos + 3 < data.length) {
    if (data[pos] !== MARKER_PREFIX) break;
    const marker = data[pos + 1]!;
    if (marker === EOI) return pos + 2;
    if (marker === SOS) {
      for (let i = pos + 4; i + 1 < data.length; i++) {
        if (isEoiAt(data, i)) return i + 2;
      }
      break;
    }
    pos += 2 + ((data[pos + 2]! << 8) | data[pos + 3]!);
  }
  for (let i = start + 2; i + 1 < data.length; i++) {
    if (isEoiAt(data, i)) return i + 2;
  }
  return Math.min(data.length, start + 4);
}
