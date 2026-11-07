// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { Component, Decoded } from './decode';
import { ZIGZAG, type Segment } from './parse';
import { COS } from './pixels';

const tmp = new Float64Array(64);

/** Forward DCT of one 8x8 block of samples, quantized with `quant` (rounded to nearest). */
export function fdctQuantize(
  plane: Uint8Array,
  planeStride: number,
  px: number,
  py: number,
  quant: Uint16Array,
  out: Int16Array,
  offset: number,
): void {
  // Rows: tmp[y][u] = sum_x (s[y][x] - 128) * COS[x][u]
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++)
        sum += (plane[(py + y) * planeStride + px + x]! - 128) * COS[x * 8 + u]!;
      tmp[y * 8 + u] = sum;
    }
  }
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += tmp[y * 8 + u]! * COS[y * 8 + v]!;
      out[offset + v * 8 + u] = Math.round(sum / quant[v * 8 + u]!);
    }
  }
}

// ---------------------------------------------------------------- Huffman encoding

interface HuffEncoder {
  codes: Uint16Array;
  sizes: Uint8Array;
  bits: Uint8Array; // 16 entries, counts per length
  values: Uint8Array;
}

/** Optimal table for the given symbol frequencies (ITU T.81 Annex K.2, as libjpeg does it). */
function optimalTable(freqIn: Int32Array): HuffEncoder {
  const freq = Int32Array.from(freqIn);
  freq[256] = 1;
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1;
    let v = 1 << 30;
    for (let i = 0; i <= 256; i++) {
      if (freq[i]! && freq[i]! <= v) {
        v = freq[i]!;
        c1 = i;
      }
    }
    let c2 = -1;
    v = 1 << 30;
    for (let i = 0; i <= 256; i++) {
      if (freq[i]! && freq[i]! <= v && i !== c1) {
        v = freq[i]!;
        c2 = i;
      }
    }
    if (c2 < 0) break;
    freq[c1] = freq[c1]! + freq[c2]!;
    freq[c2] = 0;
    codesize[c1]!++;
    while (others[c1]! >= 0) {
      c1 = others[c1]!;
      codesize[c1]!++;
    }
    others[c1] = c2;
    codesize[c2]!++;
    while (others[c2]! >= 0) {
      c2 = others[c2]!;
      codesize[c2]!++;
    }
  }
  const counts = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) counts[codesize[i]!]!++;
  for (let i = 32; i > 16; i--) {
    while (counts[i]! > 0) {
      let j = i - 2;
      while (counts[j] === 0) j--;
      counts[i]! -= 2;
      counts[i - 1]!++;
      counts[j + 1]! += 2;
      counts[j]!--;
    }
  }
  let i = 16;
  while (counts[i] === 0) i--;
  counts[i]!--; // the reserved code point

  const bits = new Uint8Array(16);
  for (let l = 1; l <= 16; l++) bits[l - 1] = counts[l]!;
  const values: number[] = [];
  for (let l = 1; l <= 32; l++) for (let j = 0; j < 256; j++) if (codesize[j] === l) values.push(j);
  const codes = new Uint16Array(256);
  const sizes = new Uint8Array(256);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let n = 0; n < bits[l - 1]!; n++) {
      codes[values[k]!] = code++;
      sizes[values[k]!] = l;
      k++;
    }
    code <<= 1;
  }
  return { codes, sizes, bits, values: Uint8Array.from(values) };
}

class BitWriter {
  private chunks: Uint8Array[] = [];
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private n = 0;

  private push(byte: number): void {
    if (this.len === this.buf.length) {
      this.chunks.push(this.buf);
      this.buf = new Uint8Array(1 << 16);
      this.len = 0;
    }
    this.buf[this.len++] = byte;
  }

  write(code: number, size: number): void {
    if (size === 0) return;
    this.acc = (this.acc << size) | (code & ((1 << size) - 1));
    this.n += size;
    while (this.n >= 8) {
      const byte = (this.acc >> (this.n - 8)) & 0xff;
      this.push(byte);
      if (byte === 0xff) this.push(0);
      this.n -= 8;
    }
    this.acc &= (1 << this.n) - 1;
  }

  finish(): Uint8Array {
    if (this.n > 0) this.write(0x7f, 8 - this.n);
    this.chunks.push(this.buf.subarray(0, this.len));
    return Buffer.concat(this.chunks);
  }
}

const category = (v: number): number => {
  let a = Math.abs(v);
  let n = 0;
  while (a) {
    n++;
    a >>= 1;
  }
  return n;
};

interface Visit {
  dc(table: number, symbol: number, bits: number, extra: number): void;
  ac(table: number, symbol: number, bits: number, extra: number): void;
}

/** Walk the coefficients in interleaved MCU order, calling `visit` for each symbol. */
function walk(decoded: Decoded, visit: Visit): void {
  const comps = decoded.components;
  const preds = new Int32Array(comps.length);
  const table = (i: number): number => (i === 0 ? 0 : 1);
  for (let mr = 0; mr < decoded.mcusPerColumn; mr++) {
    for (let mc = 0; mc < decoded.mcusPerLine; mc++) {
      for (let ci = 0; ci < comps.length; ci++) {
        const comp = comps[ci]!;
        for (let v = 0; v < comp.v; v++) {
          for (let h = 0; h < comp.h; h++) {
            const off = ((mr * comp.v + v) * comp.stride + mc * comp.h + h) * 64;
            const c = comp.coeffs;
            const diff = c[off]! - preds[ci]!;
            preds[ci] = c[off]!;
            const s = category(diff);
            visit.dc(table(ci), s, s, diff < 0 ? diff - 1 : diff);
            let run = 0;
            for (let k = 1; k < 64; k++) {
              const value = c[off + ZIGZAG[k]!]!;
              if (value === 0) {
                run++;
                continue;
              }
              while (run > 15) {
                visit.ac(table(ci), 0xf0, 0, 0);
                run -= 16;
              }
              const size = category(value);
              visit.ac(table(ci), (run << 4) | size, size, value < 0 ? value - 1 : value);
              run = 0;
            }
            if (run > 0) visit.ac(table(ci), 0, 0, 0);
          }
        }
      }
    }
  }
}

function dht(cls: number, id: number, table: HuffEncoder): Segment {
  const payload = new Uint8Array(17 + table.values.length);
  payload[0] = (cls << 4) | id;
  payload.set(table.bits, 1);
  payload.set(table.values, 17);
  return { marker: 0xc4, payload };
}

/** Segments that must not be copied into the output because the encoder writes its own. */
const OWN_MARKERS = new Set([0xc4, 0xdd]);

/**
 * Write a baseline JPEG holding exactly these coefficients: the source's quantization tables and
 * kept metadata segments verbatim, optimized Huffman tables, one interleaved scan.
 */
export function encodeCoefficients(decoded: Decoded, keptSegments: readonly Segment[]): Buffer {
  const { frame } = decoded.header;
  const comps = decoded.components;
  const nTables = comps.length === 1 ? 1 : 2;
  const dcFreq = [new Int32Array(257), new Int32Array(257)];
  const acFreq = [new Int32Array(257), new Int32Array(257)];
  walk(decoded, {
    dc: (t, symbol) => void dcFreq[t]![symbol]!++,
    ac: (t, symbol) => void acFreq[t]![symbol]!++,
  });
  const dcTab = dcFreq.slice(0, nTables).map(optimalTable);
  const acTab = acFreq.slice(0, nTables).map(optimalTable);

  const writer = new BitWriter();
  walk(decoded, {
    dc(t, symbol, bits, extra) {
      writer.write(dcTab[t]!.codes[symbol]!, dcTab[t]!.sizes[symbol]!);
      writer.write(extra, bits);
    },
    ac(t, symbol, bits, extra) {
      writer.write(acTab[t]!.codes[symbol]!, acTab[t]!.sizes[symbol]!);
      writer.write(extra, bits);
    },
  });
  const entropy = writer.finish();

  const wide = [...decoded.header.quant.values()].some((q) => q.some((v) => v > 255));
  const sof = new Uint8Array(6 + comps.length * 3);
  sof[0] = 8;
  sof[1] = frame.height >> 8;
  sof[2] = frame.height & 255;
  sof[3] = frame.width >> 8;
  sof[4] = frame.width & 255;
  sof[5] = comps.length;
  comps.forEach((c: Component, i) => {
    sof[6 + i * 3] = c.id;
    sof[7 + i * 3] = (c.h << 4) | c.v;
    sof[8 + i * 3] = c.tq;
  });
  const sos = new Uint8Array(4 + comps.length * 2);
  sos[0] = comps.length;
  comps.forEach((c, i) => {
    sos[1 + i * 2] = c.id;
    sos[2 + i * 2] = i === 0 ? 0x00 : 0x11;
  });
  sos[1 + comps.length * 2] = 0;
  sos[2 + comps.length * 2] = 63;
  sos[3 + comps.length * 2] = 0;

  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const segment = (marker: number, payload: Uint8Array): void => {
    const head = Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]);
    parts.push(head, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
  };
  for (const s of keptSegments) {
    if (!OWN_MARKERS.has(s.marker) && !(s.marker >= 0xc0 && s.marker <= 0xcf))
      segment(s.marker, s.payload);
  }
  segment(wide ? 0xc1 : 0xc0, sof);
  for (let i = 0; i < nTables; i++) segment(0xc4, dht(0, i, dcTab[i]!).payload);
  for (let i = 0; i < nTables; i++) segment(0xc4, dht(1, i, acTab[i]!).payload);
  segment(0xda, sos);
  parts.push(Buffer.from(entropy), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
