// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { PixelRect } from './geometry';
import type { Point } from './types';

const PIXEL_CENTRE = 0.5;

/** One byte per pixel, 1 = selected. Polygons fill even-odd, so overlapping contours punch holes. */
export type Mask = Uint8Array;

function fillSpan(mask: Mask, rowOffset: number, from: number, to: number): void {
  if (to <= from) return;
  mask.fill(1, rowOffset + from, rowOffset + to);
}

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
    const sampleY = y + PIXEL_CENTRE + offsetY;
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
      const from = Math.max(0, Math.ceil(crossings[i]! - PIXEL_CENTRE));
      const to = Math.min(width, Math.ceil(crossings[i + 1]! - PIXEL_CENTRE));
      fillSpan(mask, y * width, from, to);
    }
  }
  return mask;
}

export function rasterizeRectPixels(
  rect: PixelRect,
  width: number,
  height: number,
  mask: Mask = new Uint8Array(width * height),
  offsetX = 0,
  offsetY = 0,
): Mask {
  const x0 = Math.max(0, Math.ceil(rect.x - offsetX - PIXEL_CENTRE));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w - offsetX - PIXEL_CENTRE));
  const y0 = Math.max(0, Math.ceil(rect.y - offsetY - PIXEL_CENTRE));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h - offsetY - PIXEL_CENTRE));
  if (x1 <= x0) return mask;
  for (let y = y0; y < y1; y++) fillSpan(mask, y * width, x0, x1);
  return mask;
}

export function maskBounds(mask: Mask, width: number, height: number): PixelRect | undefined {
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
