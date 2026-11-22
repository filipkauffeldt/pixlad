// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { JpegError } from './errors';

export const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

export interface Segment {
  marker: number;
  payload: Uint8Array;
}

export interface ComponentInfo {
  id: number;
  h: number;
  v: number;
  tq: number;
}

export interface FrameHeader {
  sof: number;
  progressive: boolean;
  precision: number;
  width: number;
  height: number;
  components: ComponentInfo[];
  hmax: number;
  vmax: number;
}

export interface ParsedHeader {
  frame: FrameHeader;
  segments: Segment[];
  /** Offset of the first SOS marker (the 0xFF byte). */
  scanStart: number;
  /** Quantization tables in natural order, by table id. */
  quant: Map<number, Uint16Array>;
  orientation: number;
  hasAdobe: boolean;
  hasJfif: boolean;
}

export const MARKER_PREFIX = 0xff;
const TEM = 0x01;
export const SOF0_BASELINE = 0xc0;
export const SOF1_EXTENDED = 0xc1;
export const SOF2_PROGRESSIVE = 0xc2;
export const DHT = 0xc4;
const JPG = 0xc8;
const DAC = 0xcc;
const SOF_UNSUPPORTED = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
export const RST0 = 0xd0;
export const RST7 = 0xd7;
export const SOI = 0xd8;
export const EOI = 0xd9;
export const SOS = 0xda;
export const DQT = 0xdb;
export const DRI = 0xdd;
export const APP0 = 0xe0;
export const APP1 = 0xe1;
export const APP2 = 0xe2;
export const APP13_PHOTOSHOP = 0xed;
export const APP14 = 0xee;
export const COM = 0xfe;

const JFIF_ID = 'JFIF\0';
const EXIF_ID = 'Exif\0\0';
const ICC_ID = 'ICC_PROFILE\0';
const ADOBE_ID = 'Adobe';
const ADOBE_TRANSFORM_OFFSET = 11;
const ADOBE_TRANSFORM_NONE = 0;
const RGB_COMPONENT_IDS = [0x52, 0x47, 0x42];
const ORIENTATION_TAG = 0x0112;
const DEFAULT_ORIENTATION = 1;
const MAX_IFD_ENTRIES = 512;
const IFD_ENTRY_SIZE = 12;

const startsWithId = (payload: Uint8Array, id: string): boolean =>
  Buffer.from(payload.subarray(0, id.length)).toString('latin1') === id;

export const looksLikeJpeg = (data: Uint8Array): boolean =>
  data.length >= 4 && data[0] === MARKER_PREFIX && data[1] === SOI && data[2] === MARKER_PREFIX;

export function exifOrientation(segments: readonly Segment[]): number {
  for (const { marker, payload } of segments) {
    if (marker !== APP1 || payload.length < 14) continue;
    if (!startsWithId(payload, EXIF_ID)) continue;
    const tiff = payload.subarray(EXIF_ID.length);
    const little = tiff[0] === 0x49 && tiff[1] === 0x49;
    if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) continue;
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const u16 = (at: number): number => (at + 2 <= tiff.length ? view.getUint16(at, little) : 0);
    const u32 = (at: number): number => (at + 4 <= tiff.length ? view.getUint32(at, little) : 0);
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count && i < MAX_IFD_ENTRIES; i++) {
      const entry = ifd + 2 + i * IFD_ENTRY_SIZE;
      if (u16(entry) === ORIENTATION_TAG) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : DEFAULT_ORIENTATION;
      }
    }
    return DEFAULT_ORIENTATION;
  }
  return DEFAULT_ORIENTATION;
}

export const isStandalone = (marker: number): boolean =>
  marker === 0 || marker === SOI || marker === TEM || (marker >= RST0 && marker <= RST7);

const isFrameMarker = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== DHT && marker !== JPG && marker !== DAC;

function storesRgbDirectly(
  frame: FrameHeader,
  hasAdobe: boolean,
  adobeTransform: number | undefined,
  hasJfif: boolean,
): boolean {
  if (frame.components.length !== 3) return false;
  const rgbIds = frame.components.every((c, i) => c.id === RGB_COMPONENT_IDS[i]);
  return adobeTransform === ADOBE_TRANSFORM_NONE || (rgbIds && !hasJfif && !hasAdobe);
}

function parseFrame(marker: number, payload: Uint8Array): FrameHeader {
  const precision = payload[0]!;
  const height = (payload[1]! << 8) | payload[2]!;
  const width = (payload[3]! << 8) | payload[4]!;
  const count = payload[5]!;
  if (precision !== 8) throw new JpegError('unsupported', `has ${precision}-bit samples`);
  if (width === 0 || height === 0) throw new JpegError('unsupported', 'has no size in its header');
  if (count === 4) {
    throw new JpegError('cmyk', 'is a CMYK JPEG, and editing it would change its colours');
  }
  if (count !== 1 && count !== 3)
    throw new JpegError('unsupported', `has ${count} colour components`);
  const components: ComponentInfo[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 3;
    const hv = payload[at + 1]!;
    components.push({ id: payload[at]!, h: hv >> 4, v: hv & 15, tq: payload[at + 2]! });
  }
  if (components.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4)) {
    throw new JpegError('corrupt', 'has invalid sampling factors');
  }
  return {
    sof: marker,
    progressive: marker === SOF2_PROGRESSIVE,
    precision,
    width,
    height,
    components,
    hmax: Math.max(...components.map((c) => c.h)),
    vmax: Math.max(...components.map((c) => c.v)),
  };
}

function readQuantTables(payload: Uint8Array, into: Map<number, Uint16Array>): void {
  for (let at = 0; at < payload.length;) {
    const pq = payload[at]! >> 4;
    const id = payload[at]! & 15;
    at++;
    const table = new Uint16Array(64);
    for (let i = 0; i < 64; i++) {
      if (pq === 0) table[ZIGZAG[i]!] = payload[at++]!;
      else {
        table[ZIGZAG[i]!] = (payload[at]! << 8) | payload[at + 1]!;
        at += 2;
      }
    }
    into.set(id, table);
  }
}

export function parseHeader(data: Uint8Array): ParsedHeader {
  if (!looksLikeJpeg(data)) throw new JpegError('not-jpeg', 'is not a JPEG file');
  const segments: Segment[] = [];
  const quant = new Map<number, Uint16Array>();
  let frame: FrameHeader | undefined;
  let hasAdobe = false;
  let adobeTransform: number | undefined;
  let hasJfif = false;
  let pos = 2;
  for (;;) {
    while (pos < data.length && data[pos] !== MARKER_PREFIX) pos++;
    while (pos < data.length && data[pos] === MARKER_PREFIX) pos++;
    if (pos >= data.length) throw new JpegError('corrupt', 'is truncated before the image data');
    const marker = data[pos++]!;
    if (isStandalone(marker)) continue;
    if (marker === EOI) throw new JpegError('corrupt', 'has no image data');
    if (pos + 2 > data.length) throw new JpegError('corrupt', 'is truncated');
    const length = (data[pos]! << 8) | data[pos + 1]!;
    if (length < 2 || pos + length > data.length) throw new JpegError('corrupt', 'is truncated');
    const payload = data.subarray(pos + 2, pos + length);
    if (marker === SOS) {
      if (!frame) throw new JpegError('corrupt', 'has image data before its frame header');
      if (storesRgbDirectly(frame, hasAdobe, adobeTransform, hasJfif)) {
        throw new JpegError('unsupported', 'stores RGB directly instead of YCbCr');
      }
      const orientation = exifOrientation(segments);
      return { frame, segments, scanStart: pos - 2, quant, orientation, hasAdobe, hasJfif };
    }
    pos += length;

    if (isFrameMarker(marker)) {
      if (SOF_UNSUPPORTED.has(marker)) {
        throw new JpegError('unsupported', 'uses arithmetic, lossless or hierarchical JPEG coding');
      }
      if (frame) throw new JpegError('unsupported', 'has more than one frame');
      frame = parseFrame(marker, payload);
    } else if (marker === DQT) {
      readQuantTables(payload, quant);
    } else if (marker === APP14 && startsWithId(payload, ADOBE_ID)) {
      hasAdobe = true;
      adobeTransform = payload[ADOBE_TRANSFORM_OFFSET];
    } else if (marker === APP0 && startsWithId(payload, JFIF_ID)) {
      hasJfif = true;
    }
    segments.push({ marker, payload });
  }
}

export interface HeaderSummary {
  width: number;
  height: number;
  orientedWidth: number;
  orientedHeight: number;
  orientation: number;
  progressive: boolean;
  components: number;
  hasIcc: boolean;
}

export function summarize(header: ParsedHeader): HeaderSummary {
  const { width, height } = header.frame;
  const swap = header.orientation >= 5;
  return {
    width,
    height,
    orientedWidth: swap ? height : width,
    orientedHeight: swap ? width : height,
    orientation: header.orientation,
    progressive: header.frame.progressive,
    components: header.frame.components.length,
    hasIcc: header.segments.some((s) => s.marker === APP2 && startsWithId(s.payload, ICC_ID)),
  };
}

export function iccProfile(segments: readonly Segment[]): Buffer | undefined {
  const chunks: Array<{ seq: number; data: Uint8Array }> = [];
  for (const { marker, payload } of segments) {
    if (marker !== APP2 || payload.length < 14) continue;
    if (!startsWithId(payload, ICC_ID)) continue;
    chunks.push({ seq: payload[ICC_ID.length]!, data: payload.subarray(ICC_ID.length + 2) });
  }
  if (chunks.length === 0) return undefined;
  chunks.sort((a, b) => a.seq - b.seq);
  return Buffer.concat(chunks.map((c) => c.data));
}

export function storedToOriented(
  orientation: number,
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number] {
  switch (orientation) {
    case 2:
      return [width - 1 - x, y];
    case 3:
      return [width - 1 - x, height - 1 - y];
    case 4:
      return [x, height - 1 - y];
    case 5:
      return [y, x];
    case 6:
      return [height - 1 - y, x];
    case 7:
      return [height - 1 - y, width - 1 - x];
    case 8:
      return [y, width - 1 - x];
    default:
      return [x, y];
  }
}

export function orientedToStored(
  orientation: number,
  ox: number,
  oy: number,
  width: number,
  height: number,
): [number, number] {
  switch (orientation) {
    case 2:
      return [width - 1 - ox, oy];
    case 3:
      return [width - 1 - ox, height - 1 - oy];
    case 4:
      return [ox, height - 1 - oy];
    case 5:
      return [oy, ox];
    case 6:
      return [oy, height - 1 - ox];
    case 7:
      return [width - 1 - oy, height - 1 - ox];
    case 8:
      return [width - 1 - oy, ox];
    default:
      return [ox, oy];
  }
}
