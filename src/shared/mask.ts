// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { Point } from './types';

/**
 * A selection mask: one byte per pixel, 1 = selected, 0 = not selected.
 * Polygons are filled with the even-odd rule, so overlapping contours in one
 * polygon punch holes. Separate shapes are unioned.
 */
export type Mask = Uint8Array;

function fillSpan(mask: Mask, rowOffset: number, from: number, to: number): void {
  if (to <= from) return;
  mask.fill(1, rowOffset + from, rowOffset + to);
}

/**
 * Rasterise a polygon given in continuous pixel coordinates into an existing
 * mask by sampling pixel centres (y + 0.5) on every scanline.
 */
export function rasterizePolygonPixels(
  points: readonly Point[],
  width: number,
  height: number,
  mask: Mask = new Uint8Array(width * height),
  offsetX = 0,
  offsetY = 0,
): Mask {
  if (points.length < 3) return mask;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const yStart = Math.max(0, Math.floor(minY - offsetY));
  const yEnd = Math.min(height, Math.ceil(maxY - offsetY));
  const crossings: number[] = [];
  for (let y = yStart; y < yEnd; y++) {
    const sampleY = y + 0.5 + offsetY;
    crossings.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j]!;
      const b = points[i]!;
      if (a.y <= sampleY === b.y <= sampleY) continue;
      const x = a.x + ((sampleY - a.y) * (b.x - a.x)) / (b.y - a.y);
      crossings.push(x - offsetX);
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i]! - 0.5));
      const to = Math.min(width, Math.ceil(crossings[i + 1]! - 0.5));
      fillSpan(mask, y * width, from, to);
    }
  }
  return mask;
}

/** Rasterise a rect given in continuous pixel coordinates. */
export function rasterizeRectPixels(
  rect: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  mask: Mask = new Uint8Array(width * height),
  offsetX = 0,
  offsetY = 0,
): Mask {
  const x0 = Math.max(0, Math.ceil(rect.x - offsetX - 0.5));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w - offsetX - 0.5));
  const y0 = Math.max(0, Math.ceil(rect.y - offsetY - 0.5));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h - offsetY - 0.5));
  if (x1 <= x0) return mask;
  for (let y = y0; y < y1; y++) fillSpan(mask, y * width, x0, x1);
  return mask;
}

/** Tight pixel bounds of the selected pixels, or undefined when empty. */
export function maskBounds(
  mask: Mask,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | undefined {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return undefined;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
