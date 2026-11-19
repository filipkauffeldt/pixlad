// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// EXPERIMENTAL, for trying detectors and outlines out on a dev build. Models live in
// resources/models/experimental/ (see scripts/fetch-experimental-models.ts) and are not shipped.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { clamp } from '../../shared/geometry';
import type { DetectOptions, FaceDetection, FaceDetector, Point, Rect } from '../../shared/types';
import { detectFaces } from './detect';
import { mergeOverlappingDetections, nonMaximumSuppression } from './nms';

interface Img {
  rgba: Uint8Array;
  width: number;
  height: number;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Det {
  box: Box;
  score: number;
  landmarks: Point[];
  kind: 'face' | 'head';
}

const FILES = {
  'yolo-n': 'yolov8n-face.onnx',
  'yolo-s': 'yolov8s-face.onnx',
  'deim-n': 'deimv2-n-wholebody34.onnx',
  'deim-s': 'deimv2-s-wholebody34.onnx',
  mesh: 'face-landmarks.onnx',
  skin: 'selfie-multiclass.onnx',
} as const;

const sessions = new Map<string, Promise<ort.InferenceSession>>();
function session(yunetPath: string, key: keyof typeof FILES): Promise<ort.InferenceSession> {
  const path = join(dirname(yunetPath), 'experimental', FILES[key]);
  if (!existsSync(path)) {
    throw new Error(
      `Missing experimental model ${FILES[key]}. Run "pnpm fetch-experimental-models".`,
    );
  }
  let s = sessions.get(path);
  if (!s) {
    s = ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    sessions.set(path, s);
    s.catch(() => sessions.delete(path));
  }
  return s;
}

// ---- 640 px detectors -------------------------------------------------------------------------

const N = 640;
type Norm = 'yolo' | 'imagenet';

/** A source window sampled (nearest) into a 640x640 NCHW tensor, at its top left unless stretched. */
function tensor(img: Img, win: Box, scale: number, norm: Norm, stretch: boolean) {
  const plane = N * N;
  const data = new Float32Array(plane * 3);
  const mean = norm === 'imagenet' ? [0.485, 0.456, 0.406] : [0, 0, 0];
  const std = norm === 'imagenet' ? [0.229, 0.224, 0.225] : [1, 1, 1];
  if (norm === 'yolo') data.fill(114 / 255);
  const tw = stretch ? N : Math.max(1, Math.round(win.w * scale));
  const th = stretch ? N : Math.max(1, Math.round(win.h * scale));
  for (let y = 0; y < th; y++) {
    const sy = win.y + Math.min(win.h - 1, Math.floor(((y + 0.5) * win.h) / th));
    for (let x = 0; x < tw; x++) {
      const sx = win.x + Math.min(win.w - 1, Math.floor(((x + 0.5) * win.w) / tw));
      const i = (sy * img.width + sx) * 4;
      for (let c = 0; c < 3; c++) {
        data[c * plane + y * N + x] = (img.rgba[i + c]! / 255 - mean[c]!) / std[c]!;
      }
    }
  }
  return { t: new ort.Tensor('float32', data, [1, 3, N, N]), tw, th };
}

/** Like the app's YuNet pass: full-resolution tiles with 20% overlap, plus the whole region. */
/**
 * Like the app's YuNet pass: tiles with 20% overlap, plus the whole region. Tiles are full
 * resolution, or of a copy shrunk so its long edge is at most `maxEdge`.
 */
function windows(
  region: Box,
  tiles = true,
  maxEdge = Infinity,
): { win: Box; scale: number; whole: boolean }[] {
  const out: { win: Box; scale: number; whole: boolean }[] = [];
  const longest = Math.max(region.w, region.h);
  const scale = Math.min(1, maxEdge / longest);
  const tile = Math.floor(N / scale);
  if (tiles || longest <= N) {
    const step = Math.floor(tile * 0.8);
    for (let y = 0; y < region.h; y += step) {
      for (let x = 0; x < region.w; x += step) {
        const w = Math.min(tile, region.w - x);
        const h = Math.min(tile, region.h - y);
        out.push({ win: { x: region.x + x, y: region.y + y, w, h }, scale, whole: false });
        if (x + w >= region.w) break;
      }
      if (y + Math.min(tile, region.h - y) >= region.h) break;
    }
  }
  if (longest > N) out.push({ win: region, scale: N / longest, whole: true });
  return out;
}

async function yolo(img: Img, region: Box, s: ort.InferenceSession): Promise<Det[]> {
  const all: Det[] = [];
  for (const { win, scale } of windows(region)) {
    const { t, tw, th } = tensor(img, win, scale, 'yolo', false);
    const out = (await s.run({ images: t })).output0!.data as Float32Array;
    const n = 8400;
    const found: Det[] = [];
    const fx = win.w / tw;
    const fy = win.h / th;
    for (let i = 0; i < n; i++) {
      const score = out[4 * n + i]!;
      if (score < 0.4) continue;
      const cx = out[i]!;
      const cy = out[n + i]!;
      const w = out[2 * n + i]!;
      const h = out[3 * n + i]!;
      found.push({
        box: { x: win.x + (cx - w / 2) * fx, y: win.y + (cy - h / 2) * fy, w: w * fx, h: h * fy },
        score,
        landmarks: [],
        kind: 'face',
      });
    }
    all.push(...nonMaximumSuppression(found, 0.45));
  }
  return mergeOverlappingDetections(all, 0.3);
}

const HEAD = 7;
const HANDS = new Set([26, 27, 28]); // hand, hand_left, hand_right
async function deim(
  img: Img,
  region: Box,
  s: ort.InferenceSession,
  tiles: boolean,
  maxEdge = Infinity,
): Promise<{ heads: Det[]; hands: Box[] }> {
  const all: Det[] = [];
  const hands: Box[] = [];
  for (const { win, scale, whole } of windows(region, tiles, maxEdge)) {
    // Tiles keep their aspect and are padded; the whole region is stretched, as the model was trained.
    const { t, tw, th } = tensor(img, win, scale, 'imagenet', whole);
    const out = (await s.run({ images: t })).label_xyxy_score!;
    const d = out.data as Float32Array;
    const q = out.dims[1]!;
    const fx = (N / tw) * win.w;
    const fy = (N / th) * win.h;
    const found: Det[] = [];
    for (let i = 0; i < q; i++) {
      const cls = Math.round(d[i * 6]!);
      if ((cls !== HEAD && !HANDS.has(cls)) || d[i * 6 + 5]! < 0.35) continue;
      const x0 = d[i * 6 + 1]! * fx;
      const y0 = d[i * 6 + 2]! * fy;
      const x1 = d[i * 6 + 3]! * fx;
      const y1 = d[i * 6 + 4]! * fy;
      if (cls !== HEAD) {
        hands.push({ x: win.x + x0, y: win.y + y0, w: x1 - x0, h: y1 - y0 });
        continue;
      }
      found.push({
        box: { x: win.x + x0, y: win.y + y0, w: x1 - x0, h: y1 - y0 },
        score: d[i * 6 + 5]!,
        landmarks: [],
        kind: 'head',
      });
    }
    all.push(...nonMaximumSuppression(found, 0.5));
  }
  // Heads in a crowd overlap a lot: plain NMS across tiles, not the union merge.
  return { heads: nonMaximumSuppression(all, 0.5), hands };
}

/**
 * Drop detections far bigger than the crowd's (a drum skin, a face "seen" in flare smoke): over 5x
 * the median area, unless the other detector found something of a matching size there (a head and
 * a face that overlap, the smaller filling at least 15% of the larger). Only with enough
 * detections for the median to mean something.
 */
function notOversized(dets: Det[], witnesses: readonly Det[] = dets): Det[] {
  if (dets.length < 8) return dets;
  const area = (d: Det): number => d.box.w * d.box.h;
  const areas = dets.map(area).sort((p, q) => p - q);
  const median = areas[areas.length >> 1]!;
  return dets.filter((d) => {
    if (area(d) <= 5 * median) return true;
    return witnesses.some((o) => {
      if (o.kind === d.kind) return false;
      const w = Math.min(d.box.x + d.box.w, o.box.x + o.box.w) - Math.max(d.box.x, o.box.x);
      const h = Math.min(d.box.y + d.box.h, o.box.y + o.box.h) - Math.max(d.box.y, o.box.y);
      if (w <= 0 || h <= 0) return false;
      return (
        w * h >= 0.15 * Math.max(area(d), area(o)) && w * h >= 0.5 * Math.min(area(d), area(o))
      );
    });
  });
}

/**
 * Drop detections that are really a hand (a raised fist): mostly inside a detected hand box. A face
 * with a hand over the mouth stays, since most of its box is outside the hand.
 */
function notHands(dets: Det[], hands: readonly Box[]): Det[] {
  return dets.filter((det) => {
    const area = det.box.w * det.box.h;
    return !hands.some((h) => {
      const w = Math.min(det.box.x + det.box.w, h.x + h.w) - Math.max(det.box.x, h.x);
      const hh = Math.min(det.box.y + det.box.h, h.y + h.h) - Math.max(det.box.y, h.y);
      return w > 0 && hh > 0 && (w * hh) / area >= 0.5;
    });
  });
}

async function yunet(img: Img, region: Rect, yunetPath: string): Promise<Det[]> {
  const found = await detectFaces(img.rgba, img.width, img.height, region, {
    modelPath: yunetPath,
  });
  const W = img.width;
  const H = img.height;
  return found.map((f) => ({
    box: { x: f.box.x * W, y: f.box.y * H, w: f.box.w * W, h: f.box.h * H },
    score: f.score,
    landmarks: (f.landmarks ?? []).map((p) => ({ x: p.x * W, y: p.y * H })),
    kind: 'face' as const,
  }));
}

async function detect(
  img: Img,
  region: Rect,
  detector: FaceDetector,
  yunetPath: string,
): Promise<Det[]> {
  const x0 = clamp(Math.floor(region.x * img.width), 0, img.width);
  const y0 = clamp(Math.floor(region.y * img.height), 0, img.height);
  const x1 = clamp(Math.ceil((region.x + region.w) * img.width), x0, img.width);
  const y1 = clamp(Math.ceil((region.y + region.h) * img.height), y0, img.height);
  const px = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (px.w <= 0 || px.h <= 0) return [];
  switch (detector) {
    case 'yunet':
      return yunet(img, region, yunetPath);
    case 'yolo-n':
    case 'yolo-s':
      return yolo(img, px, await session(yunetPath, detector));
    case 'deim-n':
    case 'deim-s': {
      const { heads, hands } = await deim(img, px, await session(yunetPath, detector), true);
      return notHands(notOversized(heads), hands);
    }
    case 'hybrid':
    case 'hybrid-tiled': {
      // DEIMv2-S for heads: one whole-region pass, or tiles over a copy at most 2560 px long. YuNet
      // tiles at full resolution add the small faces the head pass did not see.
      const { heads, hands } = await deim(
        img,
        px,
        await session(yunetPath, 'deim-s'),
        detector === 'hybrid-tiled',
        2560,
      );
      const faces = await yunet(img, region, yunetPath);
      const loose = faces.filter((f) => {
        const cx = f.box.x + f.box.w / 2;
        const cy = f.box.y + f.box.h / 2;
        return !heads.some(
          (h) =>
            cx >= h.box.x && cx <= h.box.x + h.box.w && cy >= h.box.y && cy <= h.box.y + h.box.h,
        );
      });
      return notHands(notOversized([...heads, ...loose], [...heads, ...faces]), hands);
    }
  }
}

// ---- Outlines from a rotated square crop -------------------------------------------------------

interface Crop {
  toImage(u: number, v: number): Point;
}

/** Bilinear, rotated `size`x`size` crop as NHWC floats 0..1. */
function crop(img: Img, cx: number, cy: number, side: number, angle: number, size: number) {
  const { width: W, height: H, rgba } = img;
  const s = side / size;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const toImage = (u: number, v: number): Point => {
    const dx = (u - size / 2) * s;
    const dy = (v - size / 2) * s;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  };
  const data = new Float32Array(size * size * 3);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const p = toImage(u + 0.5, v + 0.5);
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
      const o = (v * size + u) * 3;
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c]! * (1 - fx) + rgba[i10 + c]! * fx;
        const bottom = rgba[i01 + c]! * (1 - fx) + rgba[i11 + c]! * fx;
        data[o + c] = (top * (1 - fy) + bottom * fy) / 255;
      }
    }
  }
  return { data, crop: { toImage } satisfies Crop };
}

/** Where to crop: faces get 1.5x their box, heads (which already hold hair) 1.2x. */
function framing(det: Det, angle: number, scale: number) {
  const k = det.kind === 'head' ? 1.2 : 1.5;
  return {
    cx: det.box.x + det.box.w / 2,
    cy: det.box.y + det.box.h / 2,
    side: Math.max(det.box.w, det.box.h) * k * scale,
    angle,
  };
}

// MediaPipe FACEMESH_FACE_OVAL, in ring order.
const OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

async function meshOutline(img: Img, det: Det, angle: number, s: ort.InferenceSession) {
  const f = framing(det, angle, 1);
  const { data, crop: c } = crop(img, f.cx, f.cy, f.side, f.angle, 256);
  const out = await s.run({
    [s.inputNames[0]!]: new ort.Tensor('float32', data, [1, 256, 256, 3]),
  });
  const lm = out[s.outputNames[0]!]!.data as Float32Array;
  return OVAL.map((k) => c.toImage(lm[k * 3]!, lm[k * 3 + 1]!));
}

// Selfie multiclass labels: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other.
const HAIR = 1;
const FACE_SKIN = 3;
const SEG = 256;

async function skinOutline(img: Img, det: Det, angle: number, s: ort.InferenceSession) {
  // Wide enough that hair above the face box is in the crop.
  const f = framing(det, angle, 1.35);
  const { data, crop: c } = crop(img, f.cx, f.cy, f.side, f.angle, SEG);
  const out = await s.run({
    [s.inputNames[0]!]: new ort.Tensor('float32', data, [1, SEG, SEG, 3]),
  });
  const scores = out[s.outputNames[0]!]!.data as Float32Array;
  // Only this person: an oval around the detection, reaching higher for hair on a face box. In a
  // crowd the neighbours' hair would otherwise join up into one blob.
  const perPx = SEG / f.side;
  const head = det.kind === 'head';
  const rx = det.box.w * perPx * (head ? 0.6 : 0.85);
  const ryUp = det.box.h * perPx * (head ? 0.6 : 1.05);
  const ryDown = det.box.h * perPx * (head ? 0.6 : 0.65);
  const near = (u: number, v: number): boolean => {
    const dx = (u - SEG / 2) / rx;
    const dy = (v - SEG / 2) / (v < SEG / 2 ? ryUp : ryDown);
    return dx * dx + dy * dy <= 1;
  };
  let mask: Uint8Array<ArrayBuffer> = new Uint8Array(SEG * SEG);
  for (let p = 0; p < SEG * SEG; p++) {
    if (!near(p % SEG, Math.floor(p / SEG))) continue;
    let best = 0;
    for (let k = 1; k < 6; k++) if (scores[p * 6 + k]! > scores[p * 6 + best]!) best = k;
    // Face and hair; hats, glasses, hands (body skin) and clothes stay out.
    mask[p] = best === FACE_SKIN || best === HAIR ? 1 : 0;
  }
  // Close small gaps (glasses frames, a strand of hair) so the face stays one piece.
  mask = erode(dilate(mask, 4), 4);
  let component = componentNearCentre(mask);
  if (!component) return undefined;
  // Little skin for the size of the face (a balaclava's eyeholes, a scarf over the face): grow it
  // so the whole opening is covered, not just the skin seen through it.
  let area = 0;
  for (const v of component) area += v;
  const faceW = det.box.w * perPx;
  const faceH = det.box.h * perPx;
  if (area < 0.3 * faceW * faceH) {
    component = dilate(component, Math.max(4, Math.round(0.15 * Math.max(faceW, faceH))));
  }
  const ring = radialOutline(component);
  if (ring.length < 3) return undefined;
  return ring.map((p) => c.toImage(p.x, p.y));
}

function dilate(mask: Uint8Array<ArrayBuffer>, r: number): Uint8Array<ArrayBuffer> {
  return morph(mask, r, 1);
}
function erode(mask: Uint8Array<ArrayBuffer>, r: number): Uint8Array<ArrayBuffer> {
  return morph(mask, r, 0);
}
/** Square-kernel max (value 1) or min (value 0), done as two 1-D passes. */
function morph(mask: Uint8Array<ArrayBuffer>, r: number, value: 0 | 1): Uint8Array<ArrayBuffer> {
  const pass = (src: Uint8Array<ArrayBuffer>, horizontal: boolean): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < SEG; y++) {
      for (let x = 0; x < SEG; x++) {
        let hit = value === 0 ? 1 : 0;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          const v = xx < 0 || yy < 0 || xx >= SEG || yy >= SEG ? 0 : src[yy * SEG + xx]!;
          if (v === value) {
            hit = value;
            break;
          }
        }
        out[y * SEG + x] = hit;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/** The connected face-skin region closest to the crop centre. */
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
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let radius = 0;
    for (let r = SEG; r > 0; r -= 0.5) {
      const x = Math.floor(cx + dx * r);
      const y = Math.floor(cy + dy * r);
      if (x >= 0 && y >= 0 && x < SEG && y < SEG && mask[y * SEG + x]) {
        radius = r + 0.75;
        break;
      }
    }
    radii.push(radius);
  }
  // A median of three takes the spikes (a strand of hair) off.
  return radii.map((_, k) => {
    const three = [radii[(k + RAYS - 1) % RAYS]!, radii[k]!, radii[(k + 1) % RAYS]!].sort(
      (p, q) => p - q,
    );
    const r = three[1]!;
    const angle = (2 * Math.PI * k) / RAYS;
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  });
}

const MIN_TRACE_PX = 60;

// ---- Entry -------------------------------------------------------------------------------------

export async function detectExperimental(
  img: Img,
  region: Rect,
  options: DetectOptions,
  yunetPath: string,
): Promise<FaceDetection[]> {
  const started = performance.now();
  const found = await detect(img, region, options.detector, yunetPath);
  const detected = performance.now();
  const W = img.width;
  const H = img.height;
  const refine =
    options.style === 'mesh' || options.style === 'skin'
      ? await session(yunetPath, options.style)
      : undefined;
  const out: FaceDetection[] = [];
  for (const det of found) {
    const x = clamp(det.box.x, 0, W);
    const y = clamp(det.box.y, 0, H);
    const right = clamp(det.box.x + det.box.w, 0, W);
    const bottom = clamp(det.box.y + det.box.h, 0, H);
    if (right <= x || bottom <= y) continue;
    const [re, le] = det.landmarks;
    const angle = re && le ? Math.atan2(le.y - re.y, le.x - re.x) : 0;
    let outline: Point[] | undefined;
    // Under ~60 px a traced outline is mostly guesswork and costs the same: the oval it is.
    const traceable = Math.max(det.box.w, det.box.h) >= MIN_TRACE_PX;
    if (traceable && refine && options.style === 'mesh')
      outline = await meshOutline(img, det, angle, refine);
    if (traceable && refine && options.style === 'skin') {
      outline = await skinOutline(img, det, angle, refine);
      // No face skin or hair at all: a balaclava or a mask with no holes. Leave it unblurred.
      if (!outline) continue;
    }
    out.push({
      box: { type: 'rect', x: x / W, y: y / H, w: (right - x) / W, h: (bottom - y) / H },
      score: det.score,
      landmarks: det.landmarks.map((p) => ({ x: p.x / W, y: p.y / H })),
      kind: det.kind,
      angle,
      aspect: W / H,
      ...(outline ? { outline: outline.map((p) => ({ x: p.x / W, y: p.y / H })) } : {}),
    });
  }
  console.log(
    `[experimental] ${options.detector}/${options.style}: ${out.length} found, detect ${Math.round(detected - started)} ms, outlines ${Math.round(performance.now() - detected)} ms`,
  );
  return out;
}
