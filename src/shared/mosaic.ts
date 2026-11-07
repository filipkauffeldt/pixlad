// Adapted from editing-experiment packages/retouch/src/mosaic.ts (GPL-3.0-or-later).
// Differences: the result is a sparse patch (bounding box plus a touched mask) instead of a full
// copy of the image, so memory stays proportional to the retouched area, and the export can tell
// exactly which pixels changed.
import { clamp, shapeBounds, shapesBounds } from './geometry';
import { maskBounds, rasterizePolygonPixels, rasterizeRectPixels, type Mask } from './mask';
import { isAdded, type MosaicArea, type MosaicOp, type Shape } from './types';

/** The floor for the block size: smaller blocks would leave a face recognisable. */
export const MIN_BLOCK_SIZE = 8;
/** At most this many blocks across the short side of any shape. */
export const MAX_BLOCKS_ACROSS = 8;

function validateBlockSizeRel(blockSizeRel: number): void {
  if (!Number.isFinite(blockSizeRel) || blockSizeRel <= 0) {
    throw new RangeError(`blockSizeRel must be positive, got ${blockSizeRel}`);
  }
}

const requestedBlockSize = (rel: number, width: number, height: number): number =>
  Math.max(MIN_BLOCK_SIZE, Math.round(rel * Math.max(width, height)));

/**
 * Block size for one shape: the requested one, never below 8 px, enlarged so the shape spans at
 * most 8 blocks across its short side (a 40 px face with 8 px blocks is still recognisable).
 */
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
  const shortSide = Math.min(bounds.w * width, bounds.h * height);
  return Math.max(requested, Math.ceil(shortSide / MAX_BLOCKS_ACROSS), 1);
}

/** The mosaicked pixels: an RGBA patch at (x, y), and which of its pixels the mosaic covers. */
export interface MosaicPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  /** RGBA, `width * height * 4`; only pixels with `touched = 1` are mosaic. */
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

/**
 * Mosaic one block-size class into the patch. Every enabled area is walked in render order: this
 * class's adds set pixels, any subtract clears them, so a later add covers a subtracted area again.
 */
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
  const imageX0 = clamp(Math.floor(bounds.x * width), 0, width);
  const imageY0 = clamp(Math.floor(bounds.y * height), 0, height);
  const imageX1 = clamp(Math.ceil((bounds.x + bounds.w) * width), 0, width);
  const imageY1 = clamp(Math.ceil((bounds.y + bounds.h) * height), 0, height);
  if (imageX1 <= imageX0 || imageY1 <= imageY0) return;

  const localWidth = imageX1 - imageX0;
  const localHeight = imageY1 - imageY0;
  const mask: Mask = new Uint8Array(localWidth * localHeight);
  for (const { area, blockSize: size } of ordered) {
    if (isAdded(area)) {
      if (size === blockSize) {
        paintShape(
          mask,
          localWidth,
          localHeight,
          imageX0,
          imageY0,
          area.shape,
          width,
          height,
          false,
        );
      }
    } else {
      paintShape(mask, localWidth, localHeight, imageX0, imageY0, area.shape, width, height, true);
    }
  }
  const masked = maskBounds(mask, localWidth, localHeight);
  if (!masked) return;
  const regionX0 = imageX0 + masked.x;
  const regionY0 = imageY0 + masked.y;
  const regionX1 = regionX0 + masked.w;
  const regionY1 = regionY0 + masked.h;

  for (
    let blockY = Math.floor(regionY0 / blockSize) * blockSize;
    blockY < regionY1;
    blockY += blockSize
  ) {
    for (
      let blockX = Math.floor(regionX0 / blockSize) * blockSize;
      blockX < regionX1;
      blockX += blockSize
    ) {
      const x0 = Math.max(0, blockX);
      const y0 = Math.max(0, blockY);
      const x1 = Math.min(width, blockX + blockSize);
      const y1 = Math.min(height, blockY + blockSize);
      if (x1 <= x0 || y1 <= y0) continue;
      // The average covers the whole block, also outside the selection, so the original edge
      // pixels cannot leak into the mosaic.
      const [r, g, b] = readAverage(source, width, x0, y0, x1, y1);
      const writeX0 = Math.max(x0, imageX0);
      const writeY0 = Math.max(y0, imageY0);
      const writeX1 = Math.min(x1, imageX1);
      const writeY1 = Math.min(y1, imageY1);
      if (writeX1 <= writeX0 || writeY1 <= writeY0) continue;
      for (let y = writeY0; y < writeY1; y++) {
        const maskRow = (y - imageY0) * localWidth - imageX0;
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

/**
 * Pixelate the op's areas of `rgba` (read only) into a patch, or undefined when nothing is covered.
 *
 * Blocks are aligned to the image grid, so previews and exports have the same layout. Each shape
 * gets its own block size, and shapes with the same size share one grid. Size classes run smallest
 * first; where they overlap the coarser one wins.
 */
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
  const x0 = clamp(Math.floor(bounds.x * width), 0, width);
  const y0 = clamp(Math.floor(bounds.y * height), 0, height);
  const x1 = clamp(Math.ceil((bounds.x + bounds.w) * width), 0, width);
  const y1 = clamp(Math.ceil((bounds.y + bounds.h) * height), 0, height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  const patch: MosaicPatch = {
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    rgba: new Uint8Array((x1 - x0) * (y1 - y0) * 4),
    touched: new Uint8Array((x1 - x0) * (y1 - y0)),
  };
  const sizes = [...new Set(ordered.filter((e) => e.blockSize > 0).map((e) => e.blockSize))];
  for (const blockSize of sizes.sort((a, b) => a - b)) {
    mosaicClass(rgba, patch, width, height, ordered, blockSize);
  }
  return patch;
}
