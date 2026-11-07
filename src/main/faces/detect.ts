// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Ported from editing-experiment packages/retouch (GPL-3.0-or-later); the image resize is a plain
// box filter here instead of the native core.
import type { FaceDetection, Point, Rect } from '../../shared/types';
import { clamp } from '../../shared/geometry';
import type { PixelRect } from '../../shared/geometry';
import { mergeOverlappingDetections } from './nms';
import { runYuNet, type FaceCandidate } from './yunet';

export interface DetectFacesOptions {
  /** Detector confidence, 0..1. Default 0.6. */
  scoreThreshold?: number;
  /** IoU threshold for merging overlapping boxes. Default 0.3. */
  nmsThreshold?: number;
  /** Path to the YuNet ONNX model. */
  modelPath: string;
  /** Maximum tile/input edge in pixels. Default 640. */
  maxInputEdge?: number;
  /** Tile overlap fraction when a region is given. Default 0.2. */
  tileOverlap?: number;
  /** Maximum number of faces returned. Default 5000. */
  topK?: number;
}

function validateOptions(options: DetectFacesOptions): Required<DetectFacesOptions> {
  const scoreThreshold = options.scoreThreshold ?? 0.6;
  const nmsThreshold = options.nmsThreshold ?? 0.3;
  const maxInputEdge = options.maxInputEdge ?? 640;
  const tileOverlap = options.tileOverlap ?? 0.2;
  const topK = options.topK ?? 5000;
  if (scoreThreshold < 0 || scoreThreshold > 1) {
    throw new RangeError(`detectFaces: scoreThreshold must be 0..1, got ${scoreThreshold}`);
  }
  if (nmsThreshold < 0 || nmsThreshold > 1) {
    throw new RangeError(`detectFaces: nmsThreshold must be 0..1, got ${nmsThreshold}`);
  }
  if (!Number.isFinite(maxInputEdge) || maxInputEdge < 32) {
    throw new RangeError(`detectFaces: maxInputEdge must be >= 32, got ${maxInputEdge}`);
  }
  if (tileOverlap < 0 || tileOverlap >= 1) {
    throw new RangeError(`detectFaces: tileOverlap must be 0..<1, got ${tileOverlap}`);
  }
  return {
    scoreThreshold,
    nmsThreshold,
    maxInputEdge,
    tileOverlap,
    topK,
    modelPath: options.modelPath,
  };
}

/** Copies the `regionWidth` x `regionHeight` window at (`regionX`, `regionY`) out of `rgba`. */
function cropRgba(
  rgba: Uint8Array,
  width: number,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
): Uint8Array {
  const out = new Uint8Array(regionWidth * regionHeight * 4);
  for (let row = 0; row < regionHeight; row++) {
    const start = ((regionY + row) * width + regionX) * 4;
    out.set(rgba.subarray(start, start + regionWidth * 4), row * regionWidth * 4);
  }
  return out;
}

interface MappedCandidate extends FaceCandidate {
  box: PixelRect;
}

function mapCandidate(
  candidate: FaceCandidate,
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
): MappedCandidate {
  return {
    box: {
      x: offsetX + candidate.box.x * scaleX,
      y: offsetY + candidate.box.y * scaleY,
      w: candidate.box.w * scaleX,
      h: candidate.box.h * scaleY,
    },
    score: candidate.score,
    landmarks: candidate.landmarks.map((point) => ({
      x: offsetX + point.x * scaleX,
      y: offsetY + point.y * scaleY,
    })),
  };
}

function toDetection(
  candidate: MappedCandidate,
  width: number,
  height: number,
): FaceDetection | undefined {
  const x = clamp(candidate.box.x, 0, width);
  const y = clamp(candidate.box.y, 0, height);
  const right = clamp(candidate.box.x + candidate.box.w, 0, width);
  const bottom = clamp(candidate.box.y + candidate.box.h, 0, height);
  if (right <= x || bottom <= y) return undefined;
  const landmarks: Point[] = candidate.landmarks.map((point) => ({
    x: clamp(point.x / width, 0, 1),
    y: clamp(point.y / height, 0, 1),
  }));
  return {
    box: {
      type: 'rect',
      x: x / width,
      y: y / height,
      w: (right - x) / width,
      h: (bottom - y) / height,
    },
    score: candidate.score,
    landmarks,
  };
}

/**
 * Detect faces in an RGBA buffer.
 *
 * Without a region the whole image is scaled down to at most `maxInputEdge`
 * pixels before inference. With a region the crop is kept at full resolution
 * and split into overlapping tiles, so small faces in a crowd stay detectable.
 * Returned boxes and landmarks are normalised against the full image.
 */
/** Box-filter downscale so the longer edge is at most `maxEdge`. */
function resizeRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  { maxEdge }: { maxEdge: number },
): { rgba: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * width + xx) * 4;
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * outW + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { rgba: out, width: outW, height: outH };
}

export async function detectFaces(
  rgba: Uint8Array,
  width: number,
  height: number,
  region: Rect | undefined,
  options: DetectFacesOptions,
): Promise<FaceDetection[]> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`detectFaces: invalid size ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError(
      `detectFaces: RGBA buffer is too small (${rgba.length} < ${width * height * 4})`,
    );
  }
  const settings = validateOptions(options);
  const candidates: MappedCandidate[] = [];

  if (region) {
    const regionX = clamp(Math.floor(region.x * width), 0, width);
    const regionY = clamp(Math.floor(region.y * height), 0, height);
    const regionRight = clamp(Math.ceil((region.x + region.w) * width), regionX, width);
    const regionBottom = clamp(Math.ceil((region.y + region.h) * height), regionY, height);
    const regionWidth = regionRight - regionX;
    const regionHeight = regionBottom - regionY;
    if (regionWidth <= 0 || regionHeight <= 0) return [];

    const tileWidth = Math.min(regionWidth, settings.maxInputEdge);
    const tileHeight = Math.min(regionHeight, settings.maxInputEdge);
    const stepX = Math.max(1, Math.floor(tileWidth * (1 - settings.tileOverlap)));
    const stepY = Math.max(1, Math.floor(tileHeight * (1 - settings.tileOverlap)));
    for (let tileY = 0; tileY < regionHeight; tileY += stepY) {
      const tileHeightHere = Math.min(tileHeight, regionHeight - tileY);
      for (let tileX = 0; tileX < regionWidth; tileX += stepX) {
        const tileWidthHere = Math.min(tileWidth, regionWidth - tileX);
        const found = await runYuNet(
          settings.modelPath,
          rgba,
          width,
          height,
          regionX + tileX,
          regionY + tileY,
          tileWidthHere,
          tileHeightHere,
          settings.scoreThreshold,
        );
        for (const candidate of found) {
          candidates.push(mapCandidate(candidate, regionX + tileX, regionY + tileY, 1, 1));
        }
      }
    }

    // A face wider than a tile is cut into fragments by the tiled pass. Run the
    // whole region once at `maxInputEdge` so such faces stay intact.
    const longestSide = Math.max(regionWidth, regionHeight);
    if (longestSide > settings.maxInputEdge) {
      const region = cropRgba(rgba, width, regionX, regionY, regionWidth, regionHeight);
      // The resize returns the exact size it chose; map back with that.
      const scaled = await resizeRgba(region, regionWidth, regionHeight, {
        maxEdge: Math.floor(settings.maxInputEdge),
      });
      const { width: scaledWidth, height: scaledHeight } = scaled;
      const regionRgba = scaled.rgba;
      const found = await runYuNet(
        settings.modelPath,
        regionRgba,
        scaledWidth,
        scaledHeight,
        0,
        0,
        scaledWidth,
        scaledHeight,
        settings.scoreThreshold,
      );
      const scaleX = regionWidth / scaledWidth;
      const scaleY = regionHeight / scaledHeight;
      for (const candidate of found) {
        candidates.push(mapCandidate(candidate, regionX, regionY, scaleX, scaleY));
      }
    }
  } else {
    const maxEdge = Math.floor(settings.maxInputEdge);
    const resized =
      Math.max(width, height) > maxEdge
        ? await resizeRgba(rgba.subarray(0, width * height * 4), width, height, { maxEdge })
        : { rgba, width, height };
    const resizedWidth = resized.width;
    const resizedHeight = resized.height;
    const source = resized.rgba;
    const sourceWidth = resizedWidth;
    const sourceHeight = resizedHeight;
    const found = await runYuNet(
      settings.modelPath,
      source,
      sourceWidth,
      sourceHeight,
      0,
      0,
      resizedWidth,
      resizedHeight,
      settings.scoreThreshold,
    );
    const scaleX = width / resizedWidth;
    const scaleY = height / resizedHeight;
    for (const candidate of found) {
      candidates.push(mapCandidate(candidate, 0, 0, scaleX, scaleY));
    }
  }

  const merged = mergeOverlappingDetections(candidates, settings.nmsThreshold).slice(
    0,
    settings.topK,
  );
  const detections: FaceDetection[] = [];
  for (const candidate of merged) {
    const detection = toDetection(candidate, width, height);
    if (detection) detections.push(detection);
  }
  return detections;
}
