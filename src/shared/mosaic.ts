// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Adapted from editing-experiment packages/retouch/src/mosaic.ts (GPL-3.0-or-later).
// Differences: the result is a sparse patch (bounding box plus a touched mask) instead of a full
// copy of the image, so memory stays proportional to the retouched area, and the export can tell
// exactly which pixels changed.
import { clamp, shapeBounds, shapesBounds, type PixelRect } from './geometry';
import { maskBounds, rasterizePolygonPixels, rasterizeRectPixels, type Mask } from './mask';
import { isAdded, type MosaicArea, type MosaicOp, type Rect, type Shape } from './types';

// Smaller blocks leave a face recognisable.
export const MIN_BLOCK_SIZE = 8;
// A 40 px face at 8 px blocks is still recognisable, so small shapes get bigger blocks.
export const MAX_BLOCKS_ACROSS_SHORT_SIDE = 8;

function validateBlockSizeRel(blockSizeRel: number): void {
  if (!Number.isFinite(blockSizeRel) || blockSizeRel <= 0) {
    throw new RangeError(`blockSizeRel must be positive, got ${blockSizeRel}`);
  }
}

const requestedBlockSize = (rel: number, width: number, height: number): number =>
  Math.max(MIN_BLOCK_SIZE, Math.round(rel * Math.max(width, height)));

/** The block edge in image pixels. `width` and `height` are the image's, the shape is 0..1. */
export function blockSizeForShape(
  shape: Shape,
  blockSizeRel: number,
  width: number,
  height: number,
): number {
  validateBlockSizeRel(blockSizeRel);
  const requested = requestedBlockSize(blockSizeRel, width, height);
  const bounds = shapeBounds(shape);
  if (bounds.w <= 0 || bounds.h <= 0) return requested;
  const shortSidePx = Math.min(bounds.w * width, bounds.h * height);
  const coarsestForShape = Math.ceil(shortSidePx / MAX_BLOCKS_ACROSS_SHORT_SIDE);
  return Math.max(requested, coarsestForShape, 1);
}

export interface MosaicPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `width * height * 4` bytes; only pixels with `touched = 1` are mosaic. */
  rgba: Uint8Array;
  touched: Mask;
}

function readAverage(
  rgba: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = y0; y < y1; y++) {
    let index = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, index += 4) {
      r += rgba[index]!;
      g += rgba[index + 1]!;
      b += rgba[index + 2]!;
    }
  }
  const pixels = (x1 - x0) * (y1 - y0);
  return [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)];
}

function pixelRegion(bounds: Rect, width: number, height: number): PixelRect | undefined {
  const x0 = clamp(Math.floor(bounds.x * width), 0, width);
  const y0 = clamp(Math.floor(bounds.y * height), 0, height);
  const x1 = clamp(Math.ceil((bounds.x + bounds.w) * width), 0, width);
  const y1 = clamp(Math.ceil((bounds.y + bounds.h) * height), 0, height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const alignDownToGrid = (value: number, blockSize: number): number =>
  Math.floor(value / blockSize) * blockSize;

function paintShape(
  mask: Mask,
  localWidth: number,
  localHeight: number,
  offsetX: number,
  offsetY: number,
  shape: Shape,
  width: number,
  height: number,
  clear: boolean,
): void {
  const target = clear ? new Uint8Array(mask.length) : mask;
  if (shape.type === 'rect') {
    rasterizeRectPixels(
      { x: shape.x * width, y: shape.y * height, w: shape.w * width, h: shape.h * height },
      localWidth,
      localHeight,
      target,
      offsetX,
      offsetY,
    );
  } else {
    rasterizePolygonPixels(
      shape.points.map((p) => ({ x: p.x * width, y: p.y * height })),
      localWidth,
      localHeight,
      target,
      offsetX,
      offsetY,
    );
  }
  if (!clear) return;
  for (let i = 0; i < mask.length; i++) if (target[i]) mask[i] = 0;
}

interface Ordered {
  area: MosaicArea;
  blockSize: number;
}

function maskInRenderOrder(
  region: PixelRect,
  width: number,
  height: number,
  ordered: readonly Ordered[],
  blockSize: number,
): Mask {
  const mask: Mask = new Uint8Array(region.w * region.h);
  for (const { area, blockSize: size } of ordered) {
    if (!isAdded(area)) {
      paintShape(mask, region.w, region.h, region.x, region.y, area.shape, width, height, true);
    } else if (size === blockSize) {
      paintShape(mask, region.w, region.h, region.x, region.y, area.shape, width, height, false);
    }
  }
  return mask;
}

function mosaicClass(
  source: Uint8Array,
  patch: MosaicPatch,
  width: number,
  height: number,
  ordered: readonly Ordered[],
  blockSize: number,
): void {
  const own = ordered.filter((e) => isAdded(e.area) && e.blockSize === blockSize);
  const bounds = shapesBounds(own.map((e) => e.area.shape));
  if (!bounds) return;
  const classArea = pixelRegion(bounds, width, height);
  if (!classArea) return;
  const mask = maskInRenderOrder(classArea, width, height, ordered, blockSize);
  const masked = maskBounds(mask, classArea.w, classArea.h);
  if (!masked) return;
  const selectedX0 = classArea.x + masked.x;
  const selectedY0 = classArea.y + masked.y;
  const selectedX1 = selectedX0 + masked.w;
  const selectedY1 = selectedY0 + masked.h;
  const areaX1 = classArea.x + classArea.w;
  const areaY1 = classArea.y + classArea.h;

  for (
    let blockY = alignDownToGrid(selectedY0, blockSize);
    blockY < selectedY1;
    blockY += blockSize
  ) {
    for (
      let blockX = alignDownToGrid(selectedX0, blockSize);
      blockX < selectedX1;
      blockX += blockSize
    ) {
      const x0 = Math.max(0, blockX);
      const y0 = Math.max(0, blockY);
      const x1 = Math.min(width, blockX + blockSize);
      const y1 = Math.min(height, blockY + blockSize);
      if (x1 <= x0 || y1 <= y0) continue;
      // Averaged over the whole block, also outside the selection, so no original edge pixels leak.
      const [r, g, b] = readAverage(source, width, x0, y0, x1, y1);
      const writeX0 = Math.max(x0, classArea.x);
      const writeY0 = Math.max(y0, classArea.y);
      const writeX1 = Math.min(x1, areaX1);
      const writeY1 = Math.min(y1, areaY1);
      if (writeX1 <= writeX0 || writeY1 <= writeY0) continue;
      for (let y = writeY0; y < writeY1; y++) {
        const maskRow = (y - classArea.y) * classArea.w - classArea.x;
        let index = ((y - patch.y) * patch.width + (writeX0 - patch.x)) * 4;
        let touchedIndex = (y - patch.y) * patch.width + (writeX0 - patch.x);
        for (let x = writeX0; x < writeX1; x++, index += 4, touchedIndex++) {
          if (!mask[maskRow + x]) continue;
          patch.rgba[index] = r;
          patch.rgba[index + 1] = g;
          patch.rgba[index + 2] = b;
          patch.rgba[index + 3] = 255;
          patch.touched[touchedIndex] = 1;
        }
      }
    }
  }
}

/** Reads `rgba` without changing it. Undefined when no area covers any pixel. */
export function renderMosaic(
  rgba: Uint8Array,
  width: number,
  height: number,
  op: MosaicOp,
): MosaicPatch | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`renderMosaic: invalid size ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) throw new RangeError('renderMosaic: RGBA buffer too small');
  validateBlockSizeRel(op.blockSizeRel);

  const ordered: Ordered[] = op.areas
    .filter((area) => area.enabled !== false)
    .map((area) => ({
      area,
      blockSize:
        area.mode === 'subtract'
          ? 0
          : blockSizeForShape(area.shape, op.blockSizeRel, width, height),
    }));
  const bounds = shapesBounds(ordered.filter((e) => e.blockSize > 0).map((e) => e.area.shape));
  if (!bounds) return undefined;
  const region = pixelRegion(bounds, width, height);
  if (!region) return undefined;
  const patch: MosaicPatch = {
    x: region.x,
    y: region.y,
    width: region.w,
    height: region.h,
    rgba: new Uint8Array(region.w * region.h * 4),
    touched: new Uint8Array(region.w * region.h),
  };
  const sizes = [...new Set(ordered.filter((e) => e.blockSize > 0).map((e) => e.blockSize))];
  // Smallest first: where size classes overlap, the coarser block overwrites.
  for (const blockSize of sizes.sort((a, b) => a - b)) {
    mosaicClass(rgba, patch, width, height, ordered, blockSize);
  }
  return patch;
}
