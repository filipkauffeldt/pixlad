// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Outlines of face and hair for the Outlines face shape, from the MediaPipe selfie multiclass
// segmenter. Boxes and points are in photo pixels.
import * as ort from 'onnxruntime-node';
import type { Point } from '../../shared/types';
import { outlineModel } from './models';
import type { Box, Img } from './people';

/** The segmenter's input edge. */
const SEG = 256;

// Selfie multiclass labels: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other.
const HAIR = 1;
const FACE_SKIN = 3;
const CLOTHES = 4;
const OTHER = 5;

/** Faces under this size keep the oval: a traced outline there is mostly guesswork. */
const MIN_TRACE_PX = 100;

/** A face or head to outline. */
export interface TraceItem {
  box: Box;
  kind: 'face' | 'head';
  /** Head roll in radians. */
  angle: number;
  /** A detector saw a face here. */
  confirmed: boolean;
}

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
async function segment(img: Img, crop: Crop, session: ort.InferenceSession): Promise<Uint8Array> {
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
function framing(box: Box, kind: 'face' | 'head', angle: number): Crop {
  return {
    cx: box.x + box.w / 2,
    cy: box.y + box.h / 2,
    side: Math.max(box.w, box.h) * (kind === 'head' ? 1.2 : 1.5) * 1.35,
    angle,
  };
}

/**
 * The outline of the face and hair in a crop's labels, or undefined when there is none. Only this
 * person's: an oval around the detection, reaching higher for hair on a face box, so the
 * neighbours' hair doesn't join up into one blob.
 */
function outlineFromLabels(
  item: TraceItem,
  crop: Crop,
  labels: Uint8Array,
  others: readonly TraceItem[],
): Point[] | undefined {
  const perPx = SEG / crop.side;
  // And only this person's share: a pixel nearer (relative to face size) to a neighbour's centre
  // belongs to the neighbour, so outlines in a packed crowd never overlap.
  const ownSize = Math.max(item.box.w, item.box.h) * perPx;
  const cos = Math.cos(crop.angle);
  const sin = Math.sin(crop.angle);
  const rivals = others
    .map((o) => {
      const dx = o.box.x + o.box.w / 2 - crop.cx;
      const dy = o.box.y + o.box.h / 2 - crop.cy;
      return {
        u: SEG / 2 + (dx * cos + dy * sin) * perPx,
        v: SEG / 2 + (-dx * sin + dy * cos) * perPx,
        size: Math.max(o.box.w, o.box.h) * perPx,
      };
    })
    .filter((r) => r.u > -SEG && r.u < 2 * SEG && r.v > -SEG && r.v < 2 * SEG);
  const ours = (u: number, v: number): boolean => {
    const own = Math.hypot(u - SEG / 2, v - SEG / 2) / ownSize;
    return rivals.every((r) => Math.hypot(u - r.u, v - r.v) / r.size >= own);
  };
  const head = item.kind === 'head';
  const faceW = item.box.w * perPx;
  const faceH = item.box.h * perPx;
  const rx = faceW * (head ? 0.6 : 0.85);
  const ryUp = faceH * (head ? 0.6 : 1.05);
  const ryDown = faceH * (head ? 0.6 : 0.65);
  const near = (u: number, v: number): boolean => {
    const dx = (u - SEG / 2) / rx;
    const dy = (v - SEG / 2) / (v < SEG / 2 ? ryUp : ryDown);
    return dx * dx + dy * dy <= 1;
  };
  let mask: Uint8Array<ArrayBuffer> = new Uint8Array(SEG * SEG);
  for (let p = 0; p < SEG * SEG; p++) {
    if (!near(p % SEG, Math.floor(p / SEG)) || !ours(p % SEG, Math.floor(p / SEG))) continue;
    // Face and hair; hats, glasses, hands (body skin) and clothes stay out. Hair only down to the
    // jaw: below it, "hair" is mostly a black scarf or a collar.
    const label = labels[p]!;
    const hairOk = Math.floor(p / SEG) <= SEG / 2 + faceH * (head ? 0.3 : 0.4);
    mask[p] = label === FACE_SKIN || (label === HAIR && hairOk) ? 1 : 0;
  }
  // Close small gaps (glasses frames, a strand of hair) so the face stays one piece.
  mask = erode(dilate(mask, 4), 4);
  // Where a detector saw a face, its core is always covered: smoke or odd light can hide part of
  // the skin from the segmenter, and the outline must not shrink below the face.
  if (item.confirmed) {
    const crx = faceW * (head ? 0.33 : 0.45);
    const cry = faceH * (head ? 0.33 : 0.5);
    const ccy = SEG / 2 + (head ? faceH * 0.1 : 0);
    for (let p = 0; p < SEG * SEG; p++) {
      const dx = ((p % SEG) - SEG / 2) / crx;
      const dy = (Math.floor(p / SEG) - ccy) / cry;
      // Not over clothes or a held object (a scarf held up in front of the face).
      if (dx * dx + dy * dy <= 1 && labels[p] !== CLOTHES && labels[p] !== OTHER) mask[p] = 1;
    }
  }
  const component = componentNearCentre(mask);
  if (!component) return undefined;
  let area = 0;
  for (const v of component) area += v;
  // A head nothing confirmed as a face, showing only a little skin (light or smoke hides the rest,
  // the face is turned away): the trace can't be trusted, so cover the head with an oval.
  if (head && !item.confirmed && area < 0.35 * faceW * faceH) {
    // The head's oval, less clothes (a scarf held up, a collar): those stay sharp. If that leaves
    // little (a hood or a cap the segmenter calls clothes), the whole oval.
    const oval = new Uint8Array(SEG * SEG);
    let ovalArea = 0;
    for (let p = 0; p < SEG * SEG; p++) {
      const dx = ((p % SEG) - SEG / 2) / (faceW * 0.55);
      const dy = (Math.floor(p / SEG) - SEG / 2) / (faceH * 0.55);
      if (dx * dx + dy * dy <= 1 && labels[p] !== CLOTHES) {
        oval[p] = 1;
        ovalArea++;
      }
    }
    const full = Math.PI * faceW * 0.55 * faceH * 0.55;
    const kept = ovalArea >= 0.4 * full ? componentNearCentre(oval) : undefined;
    const ring = kept ? radialOutline(kept) : [];
    if (ring.length >= 3) return ring.map((q) => toPhoto(crop, q.x, q.y));
    return Array.from({ length: 40 }, (_, k) => {
      const t = (2 * Math.PI * k) / 40;
      return toPhoto(
        crop,
        SEG / 2 + Math.cos(t) * faceW * 0.55,
        SEG / 2 + Math.sin(t) * faceH * 0.55,
      );
    });
  }
  const ring = radialOutline(component);
  return ring.length >= 3 ? ring.map((p) => toPhoto(crop, p.x, p.y)) : undefined;
}

const dilate = (mask: Uint8Array<ArrayBuffer>, r: number): Uint8Array<ArrayBuffer> =>
  morph(mask, r, 1);
const erode = (mask: Uint8Array<ArrayBuffer>, r: number): Uint8Array<ArrayBuffer> =>
  morph(mask, r, 0);

/**
 * Square-kernel max (value 1) or min (value 0), as two 1-D passes over running counts, so the cost
 * does not grow with the radius. Pixels outside the mask count as 0.
 */
function morph(mask: Uint8Array<ArrayBuffer>, r: number, value: 0 | 1): Uint8Array<ArrayBuffer> {
  const full = 2 * r + 1;
  const prefix = new Int32Array(SEG + 1);
  const pass = (src: Uint8Array<ArrayBuffer>, horizontal: boolean): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(src.length);
    for (let line = 0; line < SEG; line++) {
      for (let i = 0; i < SEG; i++) {
        const p = horizontal ? line * SEG + i : i * SEG + line;
        prefix[i + 1] = prefix[i]! + src[p]!;
      }
      for (let i = 0; i < SEG; i++) {
        const ones = prefix[Math.min(SEG, i + r + 1)]! - prefix[Math.max(0, i - r)]!;
        const p = horizontal ? line * SEG + i : i * SEG + line;
        out[p] = value === 1 ? (ones > 0 ? 1 : 0) : ones === full ? 1 : 0;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/** The connected part of the mask closest to the crop centre. */
function componentNearCentre(mask: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  let start = -1;
  let best = Infinity;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const d = ((p % SEG) - SEG / 2) ** 2 + (Math.floor(p / SEG) - SEG / 2) ** 2;
    if (d < best) {
      best = d;
      start = p;
    }
  }
  if (start < 0) return undefined;
  const out = new Uint8Array(mask.length);
  const queue = [start];
  out[start] = 1;
  while (queue.length > 0) {
    const p = queue.pop()!;
    const x = p % SEG;
    const y = Math.floor(p / SEG);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= SEG || yy >= SEG) continue;
      const q = yy * SEG + xx;
      if (mask[q] && !out[q]) {
        out[q] = 1;
        queue.push(q);
      }
    }
  }
  return out;
}

const RAYS = 72;

/**
 * A star-shaped outline around the mask: on rays from its centre, the farthest pixel that is on.
 * It never crosses itself (a traced boundary can, and the even-odd fill then punches holes in the
 * mosaic), and a hand in front of the face stays inside it.
 */
function radialOutline(mask: Uint8Array): Point[] {
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    cx += p % SEG;
    cy += Math.floor(p / SEG);
    n++;
  }
  if (n === 0) return [];
  cx = cx / n + 0.5;
  cy = cy / n + 0.5;
  const radii: number[] = [];
  for (let k = 0; k < RAYS; k++) {
    const angle = (2 * Math.PI * k) / RAYS;
    let radius = 0;
    for (let r = SEG; r > 0; r -= 0.5) {
      const x = Math.floor(cx + Math.cos(angle) * r);
      const y = Math.floor(cy + Math.sin(angle) * r);
      if (x >= 0 && y >= 0 && x < SEG && y < SEG && mask[y * SEG + x]) {
        radius = r + 0.75;
        break;
      }
    }
    radii.push(radius);
  }
  // A median of three takes the spikes (a strand of hair) off, a mean of five smooths the rest.
  // Smoothing never pulls the outline inward by more than a pixel or two.
  const median = radii.map(
    (_, k) =>
      [radii[(k + RAYS - 1) % RAYS]!, radii[k]!, radii[(k + 1) % RAYS]!].sort((p, q) => p - q)[1]!,
  );
  return median.map((_, k) => {
    let sum = 0;
    for (let d = -2; d <= 2; d++) sum += median[(k + d + RAYS) % RAYS]!;
    const r = Math.max(sum / 5, median[k]! - 1.5);
    const angle = (2 * Math.PI * k) / RAYS;
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  });
}

/**
 * Outlines for `items`, in photo pixels. Per item: the outline; null when a head shows no face skin
 * or hair at all (a balaclava, left sharp); or undefined to keep the oval (too small to trace, or a
 * confirmed face the segmenter found nothing in).
 */
export async function traceOutlines(
  img: Img,
  items: readonly TraceItem[],
  modelsDir: string,
): Promise<(Point[] | null | undefined)[]> {
  const session = await outlineModel(modelsDir, 'segmenter');
  const out: (Point[] | null | undefined)[] = [];
  for (const item of items) {
    if (Math.max(item.box.w, item.box.h) < MIN_TRACE_PX) {
      out.push(undefined);
      continue;
    }
    const crop = framing(item.box, item.kind, item.angle);
    const labels = await segment(img, crop, session);
    const outline = outlineFromLabels(
      item,
      crop,
      labels,
      items.filter((o) => o !== item),
    );
    out.push(outline ?? (item.confirmed ? undefined : null));
  }
  return out;
}
