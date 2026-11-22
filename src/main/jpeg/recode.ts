// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { MosaicPatch } from '../../shared/mosaic';
import type { Component, Decoded } from './decode';
import { fdctQuantize } from './encode';
import { orientedToStored } from './parse';
import { clamp8, type Plane } from './pixels';

const BLOCK = 8;

interface ChromaAccumulator {
  sum: Float32Array;
  count: Uint8Array;
}

const rgbToYcc = (r: number, g: number, b: number): [number, number, number] => [
  0.299 * r + 0.587 * g + 0.114 * b,
  -0.168736 * r - 0.331264 * g + 0.5 * b + 128,
  0.5 * r - 0.418688 * g - 0.081312 * b + 128,
];

const blockIndex = (comp: Component, x: number, y: number): number =>
  Math.floor(y / BLOCK) * comp.stride + Math.floor(x / BLOCK);

function copyPatchIntoPlanes(
  decoded: Decoded,
  planes: Plane[],
  patch: MosaicPatch,
  touched: Uint8Array[],
  chroma: Array<ChromaAccumulator | undefined>,
): void {
  const { frame, orientation } = decoded.header;
  const { width, height, hmax, vmax } = frame;
  const comps = decoded.components;
  for (let py = 0; py < patch.height; py++) {
    for (let px = 0; px < patch.width; px++) {
      const at = py * patch.width + px;
      if (!patch.touched[at]) continue;
      const [x, y] = orientedToStored(orientation, patch.x + px, patch.y + py, width, height);
      const [luma, cbv, crv] = rgbToYcc(
        patch.rgba[at * 4]!,
        patch.rgba[at * 4 + 1]!,
        patch.rgba[at * 4 + 2]!,
      );
      const lp = planes[0]!;
      lp.data[y * lp.width + x] = clamp8(luma);
      touched[0]![blockIndex(comps[0]!, x, y)] = 1;
      if (comps.length === 3) {
        for (let ci = 1; ci <= 2; ci++) {
          const comp = comps[ci]!;
          const cx = Math.floor((x * comp.h) / hmax);
          const cy = Math.floor((y * comp.v) / vmax);
          const slot = cy * planes[ci]!.width + cx;
          const acc = chroma[ci]!;
          acc.sum[slot] = acc.sum[slot]! + (ci === 1 ? cbv : crv);
          acc.count[slot] = acc.count[slot]! + 1;
          touched[ci]![blockIndex(comp, cx, cy)] = 1;
        }
      }
    }
  }
}

function blendChromaSamples(
  decoded: Decoded,
  planes: Plane[],
  chroma: Array<ChromaAccumulator | undefined>,
): void {
  const { hmax, vmax } = decoded.header.frame;
  const comps = decoded.components;
  for (let ci = 1; ci < comps.length; ci++) {
    const comp = comps[ci]!;
    const plane = planes[ci]!;
    const acc = chroma[ci]!;
    const pixelsPerSample = (hmax / comp.h) * (vmax / comp.v);
    for (let slot = 0; slot < acc.count.length; slot++) {
      const covered = acc.count[slot]!;
      if (covered === 0) continue;
      const uncovered = pixelsPerSample - covered;
      const mean = (acc.sum[slot]! + uncovered * plane.data[slot]!) / pixelsPerSample;
      plane.data[slot] = clamp8(mean);
    }
  }
}

function requantizeTouchedBlocks(decoded: Decoded, planes: Plane[], touched: Uint8Array[]): number {
  let rewritten = 0;
  decoded.components.forEach((comp, ci) => {
    const quant = decoded.header.quant.get(comp.tq)!;
    const plane = planes[ci]!;
    for (let row = 0; row < comp.rows; row++) {
      for (let col = 0; col < comp.stride; col++) {
        if (!touched[ci]![row * comp.stride + col]) continue;
        fdctQuantize(
          plane.data,
          plane.width,
          col * BLOCK,
          row * BLOCK,
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

/** Rewrites only the 8x8 blocks the patch touches, so every other pixel decodes unchanged. */
export function applyPatchToCoefficients(
  decoded: Decoded,
  planes: Plane[],
  patch: MosaicPatch,
): number {
  const comps = decoded.components;
  const touched = comps.map((c) => new Uint8Array(c.stride * c.rows));
  const chroma = comps.map((_, i) =>
    i === 0 || comps.length === 1
      ? undefined
      : {
          sum: new Float32Array(planes[i]!.width * planes[i]!.height),
          count: new Uint8Array(planes[i]!.width * planes[i]!.height),
        },
  );
  copyPatchIntoPlanes(decoded, planes, patch, touched, chroma);
  blendChromaSamples(decoded, planes, chroma);
  return requantizeTouchedBlocks(decoded, planes, touched);
}
