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
  /** Segment payload without the marker and the length field. */
  payload: Uint8Array;
}

export interface ComponentInfo {
  id: number;
  h: number;
  v: number;
  tq: number;
}

export interface FrameHeader {
  /** SOF marker: 0xC0 baseline, 0xC1 extended sequential, 0xC2 progressive. */
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
  /** Every segment before the first SOS, in file order. */
  segments: Segment[];
  /** Offset of the first SOS marker (the 0xFF byte). */
  scanStart: number;
  /** Quantization tables in natural order, by table id. */
  quant: Map<number, Uint16Array>;
  orientation: number;
  hasAdobe: boolean;
  hasJfif: boolean;
}

const SOF_UNSUPPORTED = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Whether the bytes start like a JPEG (SOI followed by a marker). */
export const looksLikeJpeg = (data: Uint8Array): boolean =>
  data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;

/** Read the Orientation tag (0x0112) of the first EXIF segment, 1 when absent or invalid. */
export function exifOrientation(segments: readonly Segment[]): number {
  for (const { marker, payload } of segments) {
    if (marker !== 0xe1 || payload.length < 14) continue;
    if (Buffer.from(payload.subarray(0, 6)).toString('latin1') !== 'Exif\0\0') continue;
    const tiff = payload.subarray(6);
    const little = tiff[0] === 0x49 && tiff[1] === 0x49;
    if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) continue;
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const u16 = (at: number): number => (at + 2 <= tiff.length ? view.getUint16(at, little) : 0);
    const u32 = (at: number): number => (at + 4 <= tiff.length ? view.getUint32(at, little) : 0);
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count && i < 512; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
    return 1;
  }
  return 1;
}

/** Parse markers up to the first SOS. Refuses CMYK and anything this app does not handle. */
export function parseHeader(data: Uint8Array): ParsedHeader {
  if (!looksLikeJpeg(data)) throw new JpegError('not-jpeg', 'is not a JPEG file');
  const segments: Segment[] = [];
  const quant = new Map<number, Uint16Array>();
  let frame: FrameHeader | undefined;
  let hasAdobe = false;
  let adobeTransform = -1;
  let hasJfif = false;
  let pos = 2;
  for (;;) {
    while (pos < data.length && data[pos] !== 0xff) pos++;
    while (pos < data.length && data[pos] === 0xff) pos++;
    if (pos >= data.length) throw new JpegError('corrupt', 'is truncated before the image data');
    const marker = data[pos++]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0)
      continue;
    if (marker === 0xd9) throw new JpegError('corrupt', 'has no image data');
    if (pos + 2 > data.length) throw new JpegError('corrupt', 'is truncated');
    const length = (data[pos]! << 8) | data[pos + 1]!;
    if (length < 2 || pos + length > data.length) throw new JpegError('corrupt', 'is truncated');
    const payload = data.subarray(pos + 2, pos + length);
    if (marker === 0xda) {
      if (!frame) throw new JpegError('corrupt', 'has image data before its frame header');
      if (frame.components.length === 3) {
        const ids = frame.components.map((c) => c.id).join(',');
        const rgbIds = ids === '82,71,66'; // 'R','G','B'
        if ((hasAdobe && adobeTransform === 0) || (rgbIds && !hasJfif && !hasAdobe)) {
          throw new JpegError('unsupported', 'stores RGB directly instead of YCbCr');
        }
      }
      const orientation = exifOrientation(segments);
      return { frame, segments, scanStart: pos - 2, quant, orientation, hasAdobe, hasJfif };
    }
    pos += length;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (SOF_UNSUPPORTED.has(marker)) {
        throw new JpegError('unsupported', 'uses arithmetic, lossless or hierarchical JPEG coding');
      }
      if (frame) throw new JpegError('unsupported', 'has more than one frame');
      const precision = payload[0]!;
      const height = (payload[1]! << 8) | payload[2]!;
      const width = (payload[3]! << 8) | payload[4]!;
      const count = payload[5]!;
      if (precision !== 8) throw new JpegError('unsupported', `has ${precision}-bit samples`);
      if (width === 0 || height === 0)
        throw new JpegError('unsupported', 'has no size in its header');
      if (count === 4) {
        throw new JpegError(
          'cmyk',
          'is a CMYK JPEG; its colours would have to be altered to edit it',
        );
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
      frame = {
        sof: marker,
        progressive: marker === 0xc2,
        precision,
        width,
        height,
        components,
        hmax: Math.max(...components.map((c) => c.h)),
        vmax: Math.max(...components.map((c) => c.v)),
      };
    } else if (marker === 0xdb) {
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
        quant.set(id, table);
      }
    } else if (
      marker === 0xee &&
      Buffer.from(payload.subarray(0, 5)).toString('latin1') === 'Adobe'
    ) {
      hasAdobe = true;
      adobeTransform = payload[11] ?? -1;
    } else if (
      marker === 0xe0 &&
      Buffer.from(payload.subarray(0, 5)).toString('latin1') === 'JFIF\0'
    ) {
      hasJfif = true;
    }
    segments.push({ marker, payload });
  }
}

export interface HeaderSummary {
  width: number;
  height: number;
  /** Size after EXIF orientation. */
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
    hasIcc: header.segments.some(
      (s) =>
        s.marker === 0xe2 &&
        Buffer.from(s.payload.subarray(0, 12)).toString('latin1') === 'ICC_PROFILE\0',
    ),
  };
}

/** The ICC profile, reassembled from its APP2 chunks, or undefined. */
export function iccProfile(segments: readonly Segment[]): Buffer | undefined {
  const chunks: Array<{ seq: number; data: Uint8Array }> = [];
  for (const { marker, payload } of segments) {
    if (marker !== 0xe2 || payload.length < 14) continue;
    if (Buffer.from(payload.subarray(0, 12)).toString('latin1') !== 'ICC_PROFILE\0') continue;
    chunks.push({ seq: payload[12]!, data: payload.subarray(14) });
  }
  if (chunks.length === 0) return undefined;
  chunks.sort((a, b) => a.seq - b.seq);
  return Buffer.concat(chunks.map((c) => c.data));
}

/** EXIF orientation: stored pixel (x, y) to its place in the upright image. */
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

/** The inverse: a pixel of the upright image to the stored pixel it came from. */
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
