// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// EXPERIMENTAL, for trying detectors and outlines out on a dev build. Models live in
// resources/models/experimental/ (see scripts/fetch-experimental-models.ts) and are not shipped.
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { clamp } from '../../shared/geometry';
import type {
  DetectOptions,
  FaceDetection,
  FaceDetector,
  FaceStyle,
  Point,
  Rect,
  TraceFace,
} from '../../shared/types';
import { detectFaces } from './detect';
import { mergeOverlappingDetections, nonMaximumSuppression } from './nms';

export interface Img {
  rgba: Uint8Array;
  width: number;
  height: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Det {
  box: Box;
  score: number;
  landmarks: Point[];
  kind: 'face' | 'head';
  /** YuNet saw a face here, so it is never taken for a balaclava. */
  confirmed?: boolean;
  /** Eyes DEIMv2 found inside a head: covered when nothing else is (a balaclava's eyeholes). */
  eyes?: Box[];
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
const THREADS = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
export function session(
  yunetPath: string,
  key: keyof typeof FILES,
  lane = 0,
): Promise<ort.InferenceSession> {
  const path = join(dirname(yunetPath), 'experimental', FILES[key]);
  if (!existsSync(path)) {
    throw new Error(
      `Missing experimental model ${FILES[key]}. Run "pnpm fetch-experimental-models".`,
    );
  }
  const cacheKey = `${path}#${lane}`;
  let s = sessions.get(cacheKey);
  if (!s) {
    s = ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      // Measured faster than the default (all cores) for these models, and leaves room for the
      // JavaScript work that overlaps the next run.
      intraOpNumThreads: THREADS,
    });
    sessions.set(cacheKey, s);
    s.catch(() => sessions.delete(cacheKey));
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
  whole = true,
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
  if (longest > N && whole) out.push({ win: region, scale: N / longest, whole: true });
  return out;
}

export async function yolo(img: Img, region: Box, s: ort.InferenceSession): Promise<Det[]> {
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
const FACE = 16;
const EYE = 17;
export async function deim(
  img: Img,
  region: Box,
  s: ort.InferenceSession,
  tiles: boolean,
  maxEdge = Infinity,
  whole = true,
): Promise<{ heads: Det[]; hands: Box[]; faces: Box[]; eyes: Box[] }> {
  const all: Det[] = [];
  const hands: Box[] = [];
  const faces: Box[] = [];
  const eyes: Box[] = [];
  for (const { win, scale, whole: stretched } of windows(region, tiles, maxEdge, whole)) {
    // Tiles keep their aspect and are padded; the whole region is stretched, as the model was trained.
    const { t, tw, th } = tensor(img, win, scale, 'imagenet', stretched);
    const out = (await s.run({ images: t })).label_xyxy_score!;
    const d = out.data as Float32Array;
    const q = out.dims[1]!;
    const fx = (N / tw) * win.w;
    const fy = (N / th) * win.h;
    const found: Det[] = [];
    for (let i = 0; i < q; i++) {
      const cls = Math.round(d[i * 6]!);
      const score = d[i * 6 + 5]!;
      const part = cls === FACE || cls === EYE;
      if ((cls !== HEAD && !HANDS.has(cls) && !part) || score < (part ? 0.3 : 0.35)) continue;
      const x0 = d[i * 6 + 1]! * fx;
      const y0 = d[i * 6 + 2]! * fy;
      const x1 = d[i * 6 + 3]! * fx;
      const y1 = d[i * 6 + 4]! * fy;
      if (part) {
        (cls === FACE ? faces : eyes).push({
          x: win.x + x0,
          y: win.y + y0,
          w: x1 - x0,
          h: y1 - y0,
        });
        continue;
      }
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
  // Heads in a crowd overlap a lot: plain NMS across tiles, not the union merge. A head cut by a
  // tile edge leaves a fragment inside the whole head found elsewhere; drop those.
  return { heads: withoutFragments(nonMaximumSuppression(all, 0.5)), hands, faces, eyes };
}

/** Drop boxes that lie mostly (60%+) inside a larger box. */
export function withoutFragments<T extends { box: Box }>(dets: T[]): T[] {
  const area = (b: Box): number => b.w * b.h;
  const sorted = [...dets].sort((a, b) => area(b.box) - area(a.box));
  const kept: T[] = [];
  for (const d of sorted) {
    const inside = kept.some((k) => {
      const w = Math.min(d.box.x + d.box.w, k.box.x + k.box.w) - Math.max(d.box.x, k.box.x);
      const h = Math.min(d.box.y + d.box.h, k.box.y + k.box.h) - Math.max(d.box.y, k.box.y);
      return w > 0 && h > 0 && (w * h) / area(d.box) >= 0.6;
    });
    if (!inside) kept.push(d);
  }
  return kept;
}

/**
 * Drop detections far bigger than the crowd's (a drum skin, a face "seen" in flare smoke): over 5x
 * the median area, unless the other detector found something of a matching size there (a head and
 * a face that overlap, the smaller filling at least 15% of the larger). Only with enough
 * detections for the median to mean something.
 */
export function notOversized(dets: Det[], witnesses: readonly Det[] = dets): Det[] {
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
      const ratio = area(d) / area(o);
      return (
        ratio <= 4 &&
        ratio >= 0.25 &&
        w * h >= 0.15 * Math.max(area(d), area(o)) &&
        w * h >= 0.5 * Math.min(area(d), area(o))
      );
    });
  });
}

/**
 * Drop detections that are really a hand (a raised fist): mostly inside a detected hand box. A face
 * with a hand over the mouth stays, since most of its box is outside the hand.
 */
export function notHands(dets: Det[], hands: readonly Box[], faces: readonly Box[] = []): Det[] {
  return dets.filter((det) => {
    const area = det.box.w * det.box.h;
    // DEIMv2 sometimes calls a face behind a raised fist a hand too; if it also calls it a face,
    // it is one.
    if (faces.some((f) => overlap(f, det.box) >= 0.5 * Math.min(area, f.w * f.h))) return true;
    return !hands.some((h) => {
      const w = Math.min(det.box.x + det.box.w, h.x + h.w) - Math.max(det.box.x, h.x);
      const hh = Math.min(det.box.y + det.box.h, h.y + h.h) - Math.max(det.box.y, h.y);
      return w > 0 && hh > 0 && (w * hh) / area >= 0.5;
    });
  });
}

/** Box-filter copy whose long edge is at most `maxEdge` (the image itself when it already is). */
export function shrink(img: Img, maxEdge: number): Img {
  const scale = maxEdge / Math.max(img.width, img.height);
  if (scale >= 1) return img;
  const W = img.width;
  const outW = Math.max(1, Math.round(img.width * scale));
  const outH = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(outW * outH * 4);
  const xs = new Int32Array(outW + 1);
  for (let x = 0; x <= outW; x++) xs[x] = Math.min(W, Math.round((x * W) / outW));
  const sums = new Float64Array(outW * 3);
  const counts = new Float64Array(outW);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.round((y * img.height) / outH);
    const y1 = Math.max(y0 + 1, Math.round(((y + 1) * img.height) / outH));
    sums.fill(0);
    counts.fill(0);
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * W * 4;
      for (let x = 0; x < outW; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let xx = xs[x]!; xx < xs[x + 1]!; xx++) {
          const i = row + xx * 4;
          r += img.rgba[i]!;
          g += img.rgba[i + 1]!;
          b += img.rgba[i + 2]!;
        }
        sums[x * 3] = sums[x * 3]! + r;
        sums[x * 3 + 1] = sums[x * 3 + 1]! + g;
        sums[x * 3 + 2] = sums[x * 3 + 2]! + b;
        counts[x] = counts[x]! + xs[x + 1]! - xs[x]!;
      }
    }
    for (let x = 0; x < outW; x++) {
      const o = (y * outW + x) * 4;
      const n = counts[x]!;
      out[o] = sums[x * 3]! / n;
      out[o + 1] = sums[x * 3 + 1]! / n;
      out[o + 2] = sums[x * 3 + 2]! / n;
      out[o + 3] = 255;
    }
  }
  return { rgba: out, width: outW, height: outH };
}

/** YuNet as the app runs it, optionally on a copy at most `maxEdge` long. Boxes in `img` pixels. */
export async function yunet(
  img: Img,
  region: Rect,
  yunetPath: string,
  maxEdge = Infinity,
): Promise<Det[]> {
  const src = shrink(img, maxEdge);
  const found = await detectFaces(src.rgba, src.width, src.height, region, {
    modelPath: yunetPath,
  });
  const W = img.width;
  const H = img.height;
  return found.map((f) => ({
    box: { x: f.box.x * W, y: f.box.y * H, w: f.box.w * W, h: f.box.h * H },
    score: f.score,
    landmarks: (f.landmarks ?? []).map((p) => ({ x: p.x * W, y: p.y * H })),
    kind: 'face' as const,
    confirmed: true,
  }));
}

/**
 * YuNet over a pyramid. The app's pass sees full-resolution 640 px tiles (overlapping by 128 px)
 * and the whole photo at 640: on a 24 MP photo a face of 150-600 px is cut by every tile edge and
 * only ~15 px in the whole-photo pass, so in haze it is missed. Copies at 2560 and 1280 px see those
 * faces whole.
 */
export async function yunetPyramid(img: Img, region: Rect, yunetPath: string): Promise<Det[]> {
  const longest = Math.max(img.width, img.height);
  const levels = [Infinity, 2560, 1280].filter((edge) => edge === Infinity || edge < longest / 1.5);
  const all: Det[] = [];
  for (const edge of levels) {
    const found = await yunet(img, region, yunetPath, edge);
    // The shrunk copies are there for big faces the tiles cut apart; small finds there are
    // mostly noise (a hand, a dark patch), and the full-resolution tiles see small faces anyway.
    const scale = edge === Infinity ? 1 : edge / longest;
    all.push(...found.filter((f) => edge === Infinity || Math.max(f.box.w, f.box.h) * scale >= 40));
  }
  return withoutFragments(nonMaximumSuppression(all, 0.4));
}

/**
 * One detection per person: largest first, a detection mostly (60%+) inside a kept one, or
 * overlapping it by IoU 0.45+, is the same person when the kept one is at most 4x its area. It is
 * dropped, and the kept one inherits its confirmation and eyes. A loose box over two people (more
 * than 4x a face) keeps both.
 */
function onePerPerson(dets: Det[]): Det[] {
  const area = (b: Box): number => b.w * b.h;
  const kept: Det[] = [];
  for (const d of [...dets].sort((a, b) => area(b.box) - area(a.box))) {
    const k = kept.findIndex((o) => {
      const w = Math.min(d.box.x + d.box.w, o.box.x + o.box.w) - Math.max(d.box.x, o.box.x);
      const h = Math.min(d.box.y + d.box.h, o.box.y + o.box.h) - Math.max(d.box.y, o.box.y);
      if (w <= 0 || h <= 0 || area(o.box) > 4 * area(d.box)) return false;
      const inter = w * h;
      return inter / area(d.box) >= 0.6 || inter / (area(d.box) + area(o.box) - inter) >= 0.45;
    });
    if (k < 0) {
      kept.push(d);
      continue;
    }
    const o = kept[k]!;
    kept[k] = {
      ...o,
      ...(o.confirmed || d.confirmed ? { confirmed: true } : {}),
      ...(o.landmarks.length === 0 && d.landmarks.length > 0 ? { landmarks: d.landmarks } : {}),
      ...(o.eyes || d.eyes ? { eyes: [...(o.eyes ?? []), ...(d.eyes ?? [])] } : {}),
    };
  }
  return kept;
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** A head with no face of its own needs at least this score. */
const LONE_HEAD_SCORE = 0.5;

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
  // "A copy at most 2560 px long" means a copy of the whole photo: on a region the same scale
  // applies, so heads come out the same size whatever was selected.
  const cap = (edge: number): number =>
    (edge * Math.max(px.w, px.h)) / Math.max(img.width, img.height);
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
    case 'hybrid-n':
    case 'hybrid-tiled': {
      // DEIMv2-S for heads: one whole-region pass, or tiles over a copy at most 2560 px long. YuNet
      // tiles at full resolution add the small faces the head pass did not see.
      const {
        heads,
        hands,
        faces: deimFaces,
        eyes,
      } = await deim(
        img,
        px,
        await session(yunetPath, 'deim-s'),
        detector === 'hybrid-tiled',
        cap(2560),
      );
      const iou = (a: Box, b: Box): number => {
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return w <= 0 || h <= 0 ? 0 : (w * h) / (a.w * a.h + b.w * b.h - w * h);
      };
      const inside = (a: Box, b: Box): boolean => {
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return w > 0 && h > 0 && (w * h) / (a.w * a.h) >= 0.6;
      };
      if (detector === 'hybrid-n') {
        // DEIMv2-N is ~8x cheaper than S, so it can afford tiles over a 2560 px copy: it catches
        // heads the whole-photo S pass sees too small (in smoke, half hidden by a fist).
        const more = await deim(
          img,
          px,
          await session(yunetPath, 'deim-n'),
          true,
          cap(2560),
          false,
        );
        heads.push(
          ...more.heads.filter(
            (h) => !heads.some((k) => iou(h.box, k.box) > 0.3 || inside(h.box, k.box)),
          ),
        );
        hands.push(...more.hands);
        deimFaces.push(...more.faces);
        eyes.push(...more.eyes);
      }
      // Faces anchor people: YuNet's and DEIMv2's own face boxes are tight, where head boxes in a
      // crowd are loose and overlap the neighbours. A face's outline still reaches up for hair.
      const yunetFaces = await yunetPyramid(img, region, yunetPath);
      const faces = onePerPerson([
        ...yunetFaces,
        ...deimFaces.map((f): Det => ({
          box: f,
          score: 0.5,
          landmarks: [],
          kind: 'face',
          confirmed: true,
        })),
      ]);
      // Heads add the people with no visible face: the back of a head, a balaclava. A head with a
      // face inside is that person (already in) or a loose box over several; either way it goes.
      const faceInside = (h: Det): boolean =>
        faces.some((f) => {
          const cx = f.box.x + f.box.w / 2;
          const cy = f.box.y + f.box.h / 2;
          return (
            cx >= h.box.x && cx <= h.box.x + h.box.w && cy >= h.box.y && cy <= h.box.y + h.box.h
          );
        });
      const lone = heads
        .filter(
          (h) =>
            !faceInside(h) &&
            // A faceless head scoring low is mostly an arm or a shoulder; with eyes inside it is
            // a balaclava and counts.
            (h.score >= LONE_HEAD_SCORE || eyes.some((e) => inside(e, h.box))) &&
            !faces.some((f) => overlap(f.box, h.box) > 0.25 * f.box.w * f.box.h),
        )
        .map((h): Det => {
          // Eyes inside a faceless head: a balaclava, whose eyeholes get covered.
          const own = eyes.filter((e) => inside(e, h.box));
          return own.length ? { ...h, eyes: own } : h;
        });
      return onePerPerson(
        notHands(notOversized([...faces, ...lone], [...heads, ...faces]), hands, deimFaces),
      );
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

/** The per-face crop the outline is worked out in: wide enough for hair above a face box. */
const skinFraming = (det: Det, angle: number) => framing(det, angle, 1.35);

/** Arg-max class per pixel of the segmenter's SEG x SEG x 6 scores. */
function labelsOf(scores: Float32Array): Uint8Array {
  const labels = new Uint8Array(SEG * SEG);
  for (let p = 0; p < SEG * SEG; p++) {
    let best = 0;
    for (let k = 1; k < 6; k++) if (scores[p * 6 + k]! > scores[p * 6 + best]!) best = k;
    labels[p] = best;
  }
  return labels;
}

export async function segment(
  img: Img,
  cx: number,
  cy: number,
  side: number,
  angle: number,
  s: ort.InferenceSession,
) {
  const { data, crop: c } = crop(img, cx, cy, side, angle, SEG);
  const out = await s.run({
    [s.inputNames[0]!]: new ort.Tensor('float32', data, [1, SEG, SEG, 3]),
  });
  return { labels: labelsOf(out[s.outputNames[0]!]!.data as Float32Array), crop: c };
}

export async function skinOutline(img: Img, det: Det, angle: number, s: ort.InferenceSession) {
  const f = skinFraming(det, angle);
  const { labels, crop: c } = await segment(img, f.cx, f.cy, f.side, f.angle, s);
  return outlineFromLabels(det, f.side, labels, c);
}

/**
 * Outlines for many faces. Neighbours of a similar size share one segmenter run when their crops
 * fit in `group` times one crop (each face's own crop is then sampled from the shared labels), and
 * the runs are spread over `lanes` (separate sessions), so one lane's model runs while another's
 * labels are traced.
 */
export async function skinOutlines(
  img: Img,
  items: readonly { det: Det; angle: number }[],
  lanes: readonly ort.InferenceSession[],
  group: number,
  everyone: readonly Det[] = items.map((it) => it.det),
): Promise<(Point[] | undefined)[]> {
  const rivalsOf = (j: number): Det[] => everyone.filter((d) => d !== items[j]!.det);
  const frames = items.map(({ det, angle }) => skinFraming(det, angle));
  interface Job {
    cx: number;
    cy: number;
    side: number;
    angle: number;
    members: number[];
  }
  const jobs: Job[] = [];
  const order = frames
    .map((_, i) => i)
    .sort((a, b) => frames[a]!.cy - frames[b]!.cy || frames[a]!.cx - frames[b]!.cx);
  const taken = new Uint8Array(items.length);
  for (const i of order) {
    if (taken[i]) continue;
    taken[i] = 1;
    const fi = frames[i]!;
    const T = fi.side * group;
    let [x0, y0, x1, y1] = [
      fi.cx - fi.side / 2,
      fi.cy - fi.side / 2,
      fi.cx + fi.side / 2,
      fi.cy + fi.side / 2,
    ];
    const members = [i];
    if (group > 1) {
      // Nearest first, while the union of the crops still fits in one shared crop.
      const near = order
        .filter(
          (j) => !taken[j] && frames[j]!.side >= fi.side * 0.7 && frames[j]!.side <= fi.side / 0.7,
        )
        .sort(
          (a, b) =>
            Math.hypot(frames[a]!.cx - fi.cx, frames[a]!.cy - fi.cy) -
            Math.hypot(frames[b]!.cx - fi.cx, frames[b]!.cy - fi.cy),
        );
      for (const j of near) {
        const fj = frames[j]!;
        const nx0 = Math.min(x0, fj.cx - fj.side / 2);
        const ny0 = Math.min(y0, fj.cy - fj.side / 2);
        const nx1 = Math.max(x1, fj.cx + fj.side / 2);
        const ny1 = Math.max(y1, fj.cy + fj.side / 2);
        if (nx1 - nx0 > T || ny1 - ny0 > T) continue;
        [x0, y0, x1, y1] = [nx0, ny0, nx1, ny1];
        members.push(j);
        taken[j] = 1;
      }
    }
    jobs.push(
      members.length === 1
        ? { ...fi, members }
        : { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, side: T, angle: 0, members },
    );
  }
  const out: (Point[] | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  await Promise.all(
    lanes.map(async (s) => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        const tile = await segment(img, job.cx, job.cy, job.side, job.angle, s);
        if (job.members.length === 1) {
          const j = job.members[0]!;
          out[j] = outlineFromLabels(
            items[j]!.det,
            frames[j]!.side,
            tile.labels,
            tile.crop,
            frames[j]!.angle,
            rivalsOf(j),
          );
          continue;
        }
        for (const j of job.members) {
          const fj = frames[j]!;
          // This face's own crop, sampled (nearest) from the shared labels.
          const cos = Math.cos(fj.angle);
          const sin = Math.sin(fj.angle);
          const step = fj.side / SEG;
          const labels = new Uint8Array(SEG * SEG);
          for (let v = 0; v < SEG; v++) {
            for (let u = 0; u < SEG; u++) {
              const dx = (u + 0.5 - SEG / 2) * step;
              const dy = (v + 0.5 - SEG / 2) * step;
              const tu = Math.floor(
                ((fj.cx + dx * cos - dy * sin - job.cx) / job.side + 0.5) * SEG,
              );
              const tv = Math.floor(
                ((fj.cy + dx * sin + dy * cos - job.cy) / job.side + 0.5) * SEG,
              );
              labels[v * SEG + u] =
                tu >= 0 && tv >= 0 && tu < SEG && tv < SEG ? tile.labels[tv * SEG + tu]! : 0;
            }
          }
          const toImage = (u: number, v: number): Point => {
            const dx = (u - SEG / 2) * step;
            const dy = (v - SEG / 2) * step;
            return { x: fj.cx + dx * cos - dy * sin, y: fj.cy + dx * sin + dy * cos };
          };
          out[j] = outlineFromLabels(
            items[j]!.det,
            fj.side,
            labels,
            { toImage },
            fj.angle,
            rivalsOf(j),
          );
        }
      }
    }),
  );
  return out;
}

function outlineFromLabels(
  det: Det,
  side: number,
  labels: Uint8Array,
  c: Crop,
  angle = 0,
  others: readonly Det[] = [],
) {
  // Only this person: an oval around the detection, reaching higher for hair on a face box. In a
  // crowd the neighbours' hair would otherwise join up into one blob.
  const perPx = SEG / side;
  // ...and only this person's territory: a pixel nearer (relative to face size) to a neighbour's
  // centre belongs to the neighbour, so outlines in a dense crowd never overlap.
  const ownSize = Math.max(det.box.w, det.box.h) * perPx;
  const ccx = det.box.x + det.box.w / 2;
  const ccy = det.box.y + det.box.h / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rivals = others
    .map((o) => {
      const dx = o.box.x + o.box.w / 2 - ccx;
      const dy = o.box.y + o.box.h / 2 - ccy;
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
    if (!near(p % SEG, Math.floor(p / SEG)) || !ours(p % SEG, Math.floor(p / SEG))) continue;
    // Face and hair; hats, glasses, hands (body skin) and clothes stay out.
    const label = labels[p]!;
    mask[p] = label === FACE_SKIN || label === HAIR ? 1 : 0;
  }
  // Close small gaps (glasses frames, a strand of hair) so the face stays one piece.
  mask = erode(dilate(mask, 4), 4);
  // Where YuNet saw a face, the core of the face is always covered: smoke or odd light can hide
  // part of the skin from the segmenter, and the outline must not shrink below the face.
  if (det.confirmed) {
    const crx = det.box.w * perPx * (head ? 0.33 : 0.45);
    const cry = det.box.h * perPx * (head ? 0.33 : 0.5);
    const ccy = SEG / 2 + (head ? det.box.h * perPx * 0.1 : 0);
    for (let p = 0; p < SEG * SEG; p++) {
      const dx = ((p % SEG) - SEG / 2) / crx;
      const dy = (Math.floor(p / SEG) - ccy) / cry;
      if (dx * dx + dy * dy <= 1) mask[p] = 1;
    }
  }
  let component = componentNearCentre(mask);
  if (!component) return undefined;
  // Little skin for the size of the face (a balaclava's eyeholes, a scarf over the face): grow it
  // so the whole opening is covered, not just the skin seen through it.
  let area = 0;
  for (const v of component) area += v;
  const faceW = det.box.w * perPx;
  const faceH = det.box.h * perPx;
  // A head nothing confirmed as a face, showing only a little skin (light or smoke hides the
  // rest, the face is turned away): the trace cannot be trusted, cover the head with an oval.
  if (head && !det.confirmed && area < 0.35 * faceW * faceH) {
    return Array.from({ length: 40 }, (_, k) => {
      const t = (2 * Math.PI * k) / 40;
      return c.toImage(SEG / 2 + Math.cos(t) * faceW * 0.55, SEG / 2 + Math.sin(t) * faceH * 0.55);
    });
  }
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

// ---- Entry -------------------------------------------------------------------------------------

/**
 * Experimental detection. With `deferOutlines`, traced outlines (face mesh, face and hair) are
 * left to a second call, `traceExperimental`, so the faces can show (as ovals) right away.
 */
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
  const items: { det: Det; angle: number }[] = [];
  for (const det of found) {
    const x = clamp(det.box.x, 0, W);
    const y = clamp(det.box.y, 0, H);
    const right = clamp(det.box.x + det.box.w, 0, W);
    const bottom = clamp(det.box.y + det.box.h, 0, H);
    if (right <= x || bottom <= y) continue;
    const [re, le] = det.landmarks;
    const angle = re && le ? Math.atan2(le.y - re.y, le.x - re.x) : 0;
    items.push({ det: { ...det, box: { x, y, w: right - x, h: bottom - y } }, angle });
  }
  const traced =
    options.deferOutlines || (options.style !== 'mesh' && options.style !== 'skin')
      ? items.map(() => undefined)
      : await trace(img, items, options.style, yunetPath);
  const out: FaceDetection[] = [];
  items.forEach(({ det, angle }, i) => {
    const outline = traced[i];
    if (outline === null) return; // no face skin or hair: a balaclava, left unblurred
    out.push({
      box: { type: 'rect', x: det.box.x / W, y: det.box.y / H, w: det.box.w / W, h: det.box.h / H },
      score: det.score,
      landmarks: det.landmarks.map((p) => ({ x: p.x / W, y: p.y / H })),
      kind: det.kind,
      ...(det.confirmed ? { confirmed: true } : {}),
      ...(det.eyes
        ? {
            eyes: det.eyes.map((e) => ({
              type: 'rect' as const,
              x: e.x / W,
              y: e.y / H,
              w: e.w / W,
              h: e.h / H,
            })),
          }
        : {}),
      angle,
      aspect: W / H,
      ...(outline ? { outline: outline.map((p) => ({ x: p.x / W, y: p.y / H })) } : {}),
    });
  });
  console.log(
    `[experimental] ${options.detector}/${options.style}: ${out.length} found, detect ${Math.round(detected - started)} ms, outlines ${Math.round(performance.now() - detected)} ms`,
  );
  return out;
}

/**
 * Outlines for faces already found (normalized boxes). Per face: the outline, `null` when there is
 * no face skin or hair at all (a balaclava: leave it unblurred), or undefined to keep the oval
 * (too small to trace, or nothing came of it).
 */
export async function traceExperimental(
  img: Img,
  faces: readonly TraceFace[],
  style: FaceStyle,
  yunetPath: string,
): Promise<(Point[] | null | undefined)[]> {
  const started = performance.now();
  const W = img.width;
  const H = img.height;
  const items = faces.map((f) => ({
    det: {
      box: { x: f.box.x * W, y: f.box.y * H, w: f.box.w * W, h: f.box.h * H },
      score: 1,
      landmarks: [],
      kind: f.kind ?? 'face',
      confirmed: f.confirmed ?? f.kind !== 'head',
      ...(f.eyes
        ? { eyes: f.eyes.map((e) => ({ x: e.x * W, y: e.y * H, w: e.w * W, h: e.h * H })) }
        : {}),
    } satisfies Det,
    angle: f.angle ?? 0,
  }));
  const traced = await trace(img, items, style, yunetPath);
  console.log(
    `[experimental] traced ${faces.length} ${style} outlines in ${Math.round(performance.now() - started)} ms`,
  );
  return traced.map((o) => (o ? o.map((p) => ({ x: p.x / W, y: p.y / H })) : o));
}

/** An oval over a balaclava's eyeholes: the eyes found, grown to cover the opening around them. */
function eyeholes(eyes: readonly Box[]): Point[] {
  const x0 = Math.min(...eyes.map((e) => e.x));
  const y0 = Math.min(...eyes.map((e) => e.y));
  const x1 = Math.max(...eyes.map((e) => e.x + e.w));
  const y1 = Math.max(...eyes.map((e) => e.y + e.h));
  const size = Math.max(x1 - x0, y1 - y0, ...eyes.map((e) => e.w * 2));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const a = Math.max(x1 - x0, size) * 0.8;
  const b = Math.max(y1 - y0, size * 0.35) * 1.2;
  return Array.from({ length: 32 }, (_, k) => {
    const t = (2 * Math.PI * k) / 32;
    return { x: cx + Math.cos(t) * a, y: cy + Math.sin(t) * b };
  });
}

/** Faces under this size keep the oval: a traced outline there is mostly guesswork. */
const MIN_TRACE_PX = 100;
/** Neighbours share a segmenter run when their crops fit in 1.5x one crop. */
const SKIN_GROUP = 1.5;
/** Segmenter sessions run side by side. */
const SKIN_LANES = Number(process.env.PIXLAD_SKIN_LANES ?? 1);

async function trace(
  img: Img,
  items: readonly { det: Det; angle: number }[],
  style: FaceStyle,
  yunetPath: string,
): Promise<(Point[] | null | undefined)[]> {
  const out: (Point[] | null | undefined)[] = items.map(() => undefined);
  if (style !== 'mesh' && style !== 'skin') return out;
  const s = await session(yunetPath, style);
  const big = items
    .map((it, i) => ({ ...it, i }))
    .filter(({ det }) => Math.max(det.box.w, det.box.h) >= MIN_TRACE_PX);
  if (style === 'mesh') {
    for (const { det, angle, i } of big) out[i] = await meshOutline(img, det, angle, s);
    return out;
  }
  const lanes = [
    s,
    ...(await Promise.all(
      Array.from({ length: SKIN_LANES - 1 }, (_, k) => session(yunetPath, style, k + 1)),
    )),
  ];
  const outlines = await skinOutlines(
    img,
    big,
    lanes,
    SKIN_GROUP,
    items.map((it) => it.det),
  );
  // No face skin or hair: a balaclava, left unblurred, unless YuNet saw a face there (the
  // segmenter can also miss a face in smoke or odd light): then the oval stays.
  big.forEach(({ i, det }, k) => {
    out[i] = outlines[k] ?? (det.confirmed ? undefined : det.eyes ? eyeholes(det.eyes) : null);
  });
  return out;
}
