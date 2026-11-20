// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Outlines of face and hair for the Outlines face shape, from the MediaPipe selfie multiclass
// segmenter. Boxes and points are in photo pixels.
import * as ort from 'onnxruntime-node';
import type { Point } from '../../shared/types';
import type { Box, Img } from './people';

/** The segmenter's input edge. */
const SEG = 256;

// Selfie multiclass labels: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other.
export const HAIR = 1;
export const FACE_SKIN = 3;

/** A square crop of the photo, `side` px wide and rotated by `angle`, seen at SEG x SEG. */
interface Crop {
  cx: number;
  cy: number;
  side: number;
  angle: number;
}

/** Where a point of the SEG x SEG crop lies in the photo. */
function toPhoto(crop: Crop, u: number, v: number): Point {
  const step = crop.side / SEG;
  const dx = (u - SEG / 2) * step;
  const dy = (v - SEG / 2) * step;
  const cos = Math.cos(crop.angle);
  const sin = Math.sin(crop.angle);
  return { x: crop.cx + dx * cos - dy * sin, y: crop.cy + dx * sin + dy * cos };
}

/** The crop sampled bilinearly as SEG x SEG x 3 floats, 0..1. */
function sample(img: Img, crop: Crop): Float32Array {
  const { width: W, height: H, rgba } = img;
  const data = new Float32Array(SEG * SEG * 3);
  for (let v = 0; v < SEG; v++) {
    for (let u = 0; u < SEG; u++) {
      const p = toPhoto(crop, u + 0.5, v + 0.5);
      const x = Math.min(W - 1.001, Math.max(0, p.x - 0.5));
      const y = Math.min(H - 1.001, Math.max(0, p.y - 0.5));
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * W + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + W * 4;
      const i11 = i01 + 4;
      const o = (v * SEG + u) * 3;
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c]! * (1 - fx) + rgba[i10 + c]! * fx;
        const bottom = rgba[i01 + c]! * (1 - fx) + rgba[i11 + c]! * fx;
        data[o + c] = (top * (1 - fy) + bottom * fy) / 255;
      }
    }
  }
  return data;
}

/** The label of each pixel of the crop: the segmenter's most likely class. */
export async function segment(
  img: Img,
  crop: Crop,
  session: ort.InferenceSession,
): Promise<Uint8Array> {
  const input = new ort.Tensor('float32', sample(img, crop), [1, SEG, SEG, 3]);
  const out = await session.run({ [session.inputNames[0]!]: input });
  const scores = out[session.outputNames[0]!]!.data as Float32Array;
  const labels = new Uint8Array(SEG * SEG);
  for (let p = 0; p < SEG * SEG; p++) {
    let best = 0;
    for (let k = 1; k < 6; k++) if (scores[p * 6 + k]! > scores[p * 6 + best]!) best = k;
    labels[p] = best;
  }
  return labels;
}

/**
 * The crop a face's outline is worked out in, turned with the head: a face box 1.5x and a head box
 * (which already holds hair) 1.2x, both widened by 1.35 to leave room for hair above a face.
 */
export function framing(box: Box, kind: 'face' | 'head', angle: number): Crop {
  return {
    cx: box.x + box.w / 2,
    cy: box.y + box.h / 2,
    side: Math.max(box.w, box.h) * (kind === 'head' ? 1.2 : 1.5) * 1.35,
    angle,
  };
}
