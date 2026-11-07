// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { MosaicPatch } from '../../shared/mosaic';
import type { Decoded } from './decode';
import { fdctQuantize } from './encode';
import { orientedToStored } from './parse';
import type { Plane } from './pixels';

/**
 * Write a mosaic patch (upright pixels) into the quantized coefficients, touching only the 8x8
 * blocks that contain mosaic pixels. Every other block keeps its coefficients exactly, so those
 * pixels decode identically to the source.
 *
 * For a touched block: luma samples that the mosaic covers are replaced by the patch's luma, the
 * other samples keep their decoded value, and the block is transformed and quantized again with
 * the source's own quantization table. Chroma samples cover several pixels in a subsampled
 * image: a sample becomes the mean over its pixels, where covered pixels contribute the patch's
 * chroma and the rest contribute the sample's own value.
 *
 * Returns how many blocks were rewritten (all components).
 */
export function applyPatchToCoefficients(
  decoded: Decoded,
  planes: Plane[],
  patch: MosaicPatch,
): number {
  const { frame, orientation } = decoded.header;
  const { width, height, hmax, vmax } = frame;
  const comps = decoded.components;
  const touched = comps.map((c) => new Uint8Array(c.stride * c.rows));
  // Luma-resolution RGB -> YCC of covered pixels, accumulated per chroma sample.
  const chroma = comps.map((c, i) =>
    i === 0 || comps.length === 1
      ? undefined
      : {
          sum: new Float32Array(planes[i]!.width * planes[i]!.height),
          count: new Uint8Array(planes[i]!.width * planes[i]!.height),
        },
  );

  for (let py = 0; py < patch.height; py++) {
    for (let px = 0; px < patch.width; px++) {
      const at = py * patch.width + px;
      if (!patch.touched[at]) continue;
      const [x, y] = orientedToStored(orientation, patch.x + px, patch.y + py, width, height);
      const r = patch.rgba[at * 4]!;
      const g = patch.rgba[at * 4 + 1]!;
      const b = patch.rgba[at * 4 + 2]!;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const lp = planes[0]!;
      lp.data[y * lp.width + x] = Math.min(255, Math.max(0, Math.round(luma)));
      touched[0]![Math.floor(y / 8) * comps[0]!.stride + Math.floor(x / 8)] = 1;
      if (comps.length === 3) {
        const cbv = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
        const crv = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
        for (let ci = 1; ci <= 2; ci++) {
          const comp = comps[ci]!;
          const cx = Math.floor((x * comp.h) / hmax);
          const cy = Math.floor((y * comp.v) / vmax);
          const plane = planes[ci]!;
          const slot = cy * plane.width + cx;
          const acc = chroma[ci]!;
          acc.sum[slot] = acc.sum[slot]! + (ci === 1 ? cbv : crv);
          acc.count[slot] = acc.count[slot]! + 1;
          touched[ci]![Math.floor(cy / 8) * comp.stride + Math.floor(cx / 8)] = 1;
        }
      }
    }
  }

  for (let ci = 1; ci < comps.length; ci++) {
    const comp = comps[ci]!;
    const plane = planes[ci]!;
    const acc = chroma[ci]!;
    const group = (hmax / comp.h) * (vmax / comp.v);
    for (let slot = 0; slot < acc.count.length; slot++) {
      const n = acc.count[slot]!;
      if (n === 0) continue;
      const original = plane.data[slot]!;
      const mean = (acc.sum[slot]! + (group - n) * original) / group;
      plane.data[slot] = Math.min(255, Math.max(0, Math.round(mean)));
    }
  }

  let rewritten = 0;
  comps.forEach((comp, ci) => {
    const quant = decoded.header.quant.get(comp.tq)!;
    const plane = planes[ci]!;
    for (let row = 0; row < comp.rows; row++) {
      for (let col = 0; col < comp.stride; col++) {
        if (!touched[ci]![row * comp.stride + col]) continue;
        fdctQuantize(
          plane.data,
          plane.width,
          col * 8,
          row * 8,
          quant,
          comp.coeffs,
          (row * comp.stride + col) * 64,
        );
        rewritten++;
      }
    }
  });
  return rewritten;
}
