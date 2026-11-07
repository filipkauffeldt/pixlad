// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { Component, Decoded } from './decode';
import { storedToOriented } from './parse';

// Orthonormal 8-point DCT basis: COS[x * 8 + u] = c(u)/2 * cos((2x+1) u pi / 16).
export const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    COS[x * 8 + u] =
      (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

const tmp = new Float64Array(64);

/** Dequantize and inverse-transform one block into `plane` (level shifted, clamped, rounded). */
export function idctBlock(
  coeffs: Int16Array,
  offset: number,
  quant: Uint16Array,
  plane: Uint8Array,
  planeStride: number,
  px: number,
  py: number,
): void {
  let acOnlyZero = true;
  for (let i = 1; i < 64; i++) {
    if (coeffs[offset + i] !== 0) {
      acOnlyZero = false;
      break;
    }
  }
  if (acOnlyZero) {
    const v = Math.min(255, Math.max(0, Math.round((coeffs[offset]! * quant[0]!) / 8 + 128)));
    for (let y = 0; y < 8; y++)
      plane.fill(v, (py + y) * planeStride + px, (py + y) * planeStride + px + 8);
    return;
  }
  // Columns: tmp[y][u] = sum_v F[v][u] * COS[y][v]
  for (let u = 0; u < 8; u++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        const c = coeffs[offset + v * 8 + u]!;
        if (c !== 0) sum += c * quant[v * 8 + u]! * COS[y * 8 + v]!;
      }
      tmp[y * 8 + u] = sum;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += tmp[y * 8 + u]! * COS[x * 8 + u]!;
      plane[(py + y) * planeStride + px + x] = Math.min(255, Math.max(0, Math.round(sum + 128)));
    }
  }
}

export interface Plane {
  data: Uint8Array;
  /** Width in samples (stride), a whole number of blocks. */
  width: number;
  height: number;
}

/** Decode every component to its own sample plane, padded to whole MCUs. */
export function decodePlanes(decoded: Decoded): Plane[] {
  return decoded.components.map((comp) => planeOf(decoded, comp));
}

function planeOf(decoded: Decoded, comp: Component): Plane {
  const quant = decoded.header.quant.get(comp.tq);
  if (!quant) throw new Error('JPEG has no quantization table for a component');
  const width = comp.stride * 8;
  const height = comp.rows * 8;
  const data = new Uint8Array(width * height);
  for (let row = 0; row < comp.rows; row++) {
    for (let col = 0; col < comp.stride; col++) {
      idctBlock(comp.coeffs, (row * comp.stride + col) * 64, quant, data, width, col * 8, row * 8);
    }
  }
  return { data, width, height };
}

/**
 * Upright RGBA of the decoded image: chroma replicated (nearest), JFIF YCbCr to RGB, EXIF
 * orientation applied. No colour management: values are exactly what the file stores.
 */
export function planesToRgba(decoded: Decoded, planes: Plane[]): Uint8Array {
  const { frame, orientation } = decoded.header;
  const { width, height, hmax, vmax } = frame;
  const swap = orientation >= 5;
  const outWidth = swap ? height : width;
  const out = new Uint8Array(outWidth * (swap ? width : height) * 4);
  const y = planes[0]!;
  const cb = planes[1];
  const cr = planes[2];
  const hx = frame.components.map((c) => hmax / c.h);
  const vy = frame.components.map((c) => vmax / c.v);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const lum = y.data[row * y.width + col]!;
      let r = lum;
      let g = lum;
      let b = lum;
      if (cb && cr) {
        const cbv = cb.data[Math.floor(row / vy[1]!) * cb.width + Math.floor(col / hx[1]!)]! - 128;
        const crv = cr.data[Math.floor(row / vy[2]!) * cr.width + Math.floor(col / hx[2]!)]! - 128;
        r = lum + 1.402 * crv;
        g = lum - 0.344136 * cbv - 0.714136 * crv;
        b = lum + 1.772 * cbv;
      }
      const [ox, oy] = storedToOriented(orientation, col, row, width, height);
      const at = (oy * outWidth + ox) * 4;
      out[at] = clamp8(r);
      out[at + 1] = clamp8(g);
      out[at + 2] = clamp8(b);
      out[at + 3] = 255;
    }
  }
  return out;
}

export const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * An eighth-size RGB image from DC values only (each pixel is the mean of an 8x8 block), upright.
 */
export function dcThumbnail(decoded: Decoded): { rgba: Uint8Array; width: number; height: number } {
  const { frame, orientation } = decoded.header;
  const comps = decoded.components;
  const bw = Math.ceil(frame.width / 8);
  const bh = Math.ceil(frame.height / 8);
  const swap = orientation >= 5;
  const outW = swap ? bh : bw;
  const outH = swap ? bw : bh;
  const out = new Uint8Array(outW * outH * 4);
  const q = comps.map((c) => decoded.header.quant.get(c.tq)?.[0] ?? 1);
  const sample = (ci: number, col: number, row: number): number => {
    const c = comps[ci]!;
    const sc = Math.min(c.stride - 1, Math.floor((col * c.h) / frame.hmax));
    const sr = Math.min(c.rows - 1, Math.floor((row * c.v) / frame.vmax));
    return (c.dc![sr * c.stride + sc]! * q[ci]!) / 8 + 128;
  };
  for (let row = 0; row < bh; row++) {
    for (let col = 0; col < bw; col++) {
      const lum = sample(0, col, row);
      let r = lum;
      let g = lum;
      let b = lum;
      if (comps.length === 3) {
        const cbv = sample(1, col, row) - 128;
        const crv = sample(2, col, row) - 128;
        r = lum + 1.402 * crv;
        g = lum - 0.344136 * cbv - 0.714136 * crv;
        b = lum + 1.772 * cbv;
      }
      const [ox, oy] = storedToOriented(orientation, col, row, bw, bh);
      const at = (oy * outW + ox) * 4;
      out[at] = clamp8(r);
      out[at + 1] = clamp8(g);
      out[at + 2] = clamp8(b);
      out[at + 3] = 255;
    }
  }
  return { rgba: out, width: outW, height: outH };
}
