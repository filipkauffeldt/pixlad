// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Finds the people in a crowd for the Outlines face shape: faces with YuNet, and heads (also turned
// away), faces, eyes and hands with DEIMv2 Wholebody34. Boxes are in photo pixels.
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { clamp } from '../../shared/geometry';
import type { Point, Rect } from '../../shared/types';
import { detectFaces } from './detect';
import { outlineModel } from './models';
import { nonMaximumSuppression } from './nms';

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

export interface Person {
  box: Box;
  score: number;
  landmarks: Point[];
  /** A head box holds hair and ears; a face box does not. */
  kind: 'face' | 'head';
  /** Which pass found it. */
  from: 'yunet' | 'dehazed' | 'deimv2';
  /** A detector saw a face here. */
  confirmed?: boolean;
  /** Eyes inside a head with no face of its own: a balaclava's eyeholes. */
  eyes?: Box[];
}

const YUNET = 'face_detection_yunet_2026may.onnx';

/** DEIMv2 Wholebody34 classes. */
const HEAD = 7;
const FACE = 16;
const EYE = 17;
const HANDS = new Set([26, 27, 28]); // hand, hand_left, hand_right

/** DEIMv2's input edge. */
const N = 640;

/** A head with no face of its own needs at least this score. */
const LONE_HEAD_SCORE = 0.5;
/** A head covering this much of someone's face is that person's neighbour's box, not a person. */
const CLIP = 0.5;

/** A face the dehazed pass finds counts only where the photo's spread of brightness is below this. */
const HAZE_CONTRAST = 30;

/** The lowest YuNet score that counts, for a face inside a head. */
const WEAK_FACE = 0.4;

const area = (b: Box): number => b.w * b.h;

/**
 * Whether `face` sits where a face would in `head`: the middle half across, the 20-70% band down.
 * A weak box lower down is a chin and a scarf.
 */
function holdsFace(head: Person, face: Person): boolean {
  const h = head.box;
  const cx = face.box.x + face.box.w / 2;
  const cy = face.box.y + face.box.h / 2;
  return (
    head.score >= 0.4 &&
    Math.abs(cx - (h.x + h.w / 2)) <= h.w * 0.25 &&
    cy >= h.y + h.h * 0.2 &&
    cy <= h.y + h.h * 0.7 &&
    area(h) <= 6 * area(face.box)
  );
}

export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const centreIn = (a: Box, b: Box): boolean => {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
};

/** Mostly (60%+) inside the other box. */
const inside = (a: Box, b: Box): boolean => overlap(a, b) >= 0.6 * area(a);

const iou = (a: Box, b: Box): number => {
  const shared = overlap(a, b);
  return shared === 0 ? 0 : shared / (area(a) + area(b) - shared);
};

/**
 * A source window sampled (nearest) into a 640x640 NCHW tensor with ImageNet normalisation, at
 * its top left (the rest zero) unless stretched.
 */
function tensor(img: Img, win: Box, scale: number, stretch: boolean) {
  const plane = N * N;
  const data = new Float32Array(plane * 3);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
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

/**
 * Tiles with 20% overlap over a copy whose long edge is at most `maxEdge`, and with `whole` the
 * whole region at 640 px too.
 */
function windows(
  region: Box,
  maxEdge: number,
  tiles: boolean,
  whole: boolean,
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

interface Parts {
  heads: Person[];
  faces: Box[];
  eyes: Box[];
  hands: Box[];
}

/** DEIMv2 over `region`: the heads, and the faces, eyes and hands it also finds. */
async function deimv2(
  img: Img,
  region: Box,
  session: ort.InferenceSession,
  maxEdge: number,
  tiles: boolean,
  whole: boolean,
): Promise<Parts> {
  const heads: Person[] = [];
  const parts: Parts = { heads: [], faces: [], eyes: [], hands: [] };
  for (const { win, scale, whole: stretched } of windows(region, maxEdge, tiles, whole)) {
    // Tiles keep their aspect and are padded; the whole region is stretched, as the model was
    // trained.
    const { t, tw, th } = tensor(img, win, scale, stretched);
    const out = (await session.run({ images: t })).label_xyxy_score!;
    const d = out.data as Float32Array;
    const fx = (N / tw) * win.w;
    const fy = (N / th) * win.h;
    const found: Person[] = [];
    for (let i = 0; i < out.dims[1]!; i++) {
      const cls = Math.round(d[i * 6]!);
      const score = d[i * 6 + 5]!;
      const part = cls === FACE || cls === EYE;
      if ((cls !== HEAD && !HANDS.has(cls) && !part) || score < (part ? 0.3 : 0.35)) continue;
      const x0 = d[i * 6 + 1]! * fx;
      const y0 = d[i * 6 + 2]! * fy;
      const box = {
        x: win.x + x0,
        y: win.y + y0,
        w: d[i * 6 + 3]! * fx - x0,
        h: d[i * 6 + 4]! * fy - y0,
      };
      if (cls === FACE) parts.faces.push(box);
      else if (cls === EYE) parts.eyes.push(box);
      else if (cls !== HEAD) parts.hands.push(box);
      else found.push({ box, score, landmarks: [], kind: 'head', from: 'deimv2' });
    }
    heads.push(...nonMaximumSuppression(found, 0.5));
  }
  // Heads in a crowd overlap a lot: plain NMS across tiles, not a union merge. A head cut by a tile
  // edge leaves a fragment inside the whole head found elsewhere; drop those.
  parts.heads = withoutFragments(nonMaximumSuppression(heads, 0.5));
  return parts;
}

/** Drop boxes that lie mostly (60%+) inside a larger box. */
function withoutFragments<T extends { box: Box }>(dets: T[]): T[] {
  const kept: T[] = [];
  for (const d of [...dets].sort((a, b) => area(b.box) - area(a.box))) {
    if (!kept.some((k) => inside(d.box, k.box))) kept.push(d);
  }
  return kept;
}

/** Box-filter copy whose long edge is at most `maxEdge` (the image itself when it already is). */
function shrink(img: Img, maxEdge: number): Img {
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

/** YuNet as Find all faces runs it, on a copy at most `maxEdge` long. Boxes in `img` pixels. */
async function yunet(
  img: Img,
  region: Rect,
  modelsDir: string,
  maxEdge = Infinity,
  scoreThreshold = 0.6,
): Promise<Person[]> {
  const src = shrink(img, maxEdge);
  const found = await detectFaces(src.rgba, src.width, src.height, region, {
    modelPath: join(modelsDir, YUNET),
    scoreThreshold,
  });
  return found.map((f) => ({
    box: {
      x: f.box.x * img.width,
      y: f.box.y * img.height,
      w: f.box.w * img.width,
      h: f.box.h * img.height,
    },
    score: f.score,
    landmarks: (f.landmarks ?? []).map((p) => ({ x: p.x * img.width, y: p.y * img.height })),
    kind: 'face' as const,
    from: 'yunet' as const,
    confirmed: true,
  }));
}

/**
 * Haze removal for flare smoke: each colour channel is stretched to its local (96 px) mean and
 * spread, interpolated between tiles, which takes the coloured haze out and gives faces behind it
 * their contrast back.
 */
function dehaze(img: Img, tile = 96, spread = 2.2): Img {
  const { width: W, height: H, rgba } = img;
  const tx = Math.ceil(W / tile);
  const ty = Math.ceil(H / tile);
  const mean = new Float32Array(tx * ty * 3);
  const sd = new Float32Array(tx * ty * 3);
  const sum = new Float64Array(tx * ty * 3);
  const sq = new Float64Array(tx * ty * 3);
  const n = new Float64Array(tx * ty);
  for (let y = 0; y < H; y += 2) {
    const row = Math.floor(y / tile) * tx;
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const t = row + Math.floor(x / tile);
      for (let k = 0; k < 3; k++) {
        const v = rgba[i + k]!;
        sum[t * 3 + k] = sum[t * 3 + k]! + v;
        sq[t * 3 + k] = sq[t * 3 + k]! + v * v;
      }
      n[t] = n[t]! + 1;
    }
  }
  for (let t = 0; t < tx * ty; t++) {
    for (let k = 0; k < 3; k++) {
      const m = sum[t * 3 + k]! / n[t]!;
      mean[t * 3 + k] = m;
      sd[t * 3 + k] = Math.max(6, Math.sqrt(Math.max(0, sq[t * 3 + k]! / n[t]! - m * m)));
    }
  }
  const lerp = (
    arr: Float32Array,
    corners: number[],
    wx: number,
    wy: number,
    k: number,
  ): number => {
    const [a, b, c, d] = corners as [number, number, number, number];
    return (
      (arr[a * 3 + k]! * (1 - wx) + arr[b * 3 + k]! * wx) * (1 - wy) +
      (arr[c * 3 + k]! * (1 - wx) + arr[d * 3 + k]! * wx) * wy
    );
  };
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(ty - 1, Math.max(0, (y + 0.5) / tile - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(ty - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(tx - 1, Math.max(0, (x + 0.5) / tile - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(tx - 1, x0 + 1);
      const wx = fx - x0;
      const corners = [y0 * tx + x0, y0 * tx + x1, y1 * tx + x0, y1 * tx + x1];
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const m = lerp(mean, corners, wx, wy, k);
        const s = lerp(sd, corners, wx, wy, k);
        out[i + k] = Math.max(0, Math.min(255, 128 + ((rgba[i + k]! - m) * 128) / (spread * s)));
      }
      out[i + 3] = 255;
    }
  }
  return { rgba: out, width: W, height: H };
}

/** A copy of `box` plus a margin, with the offset to map its coordinates back. */
function cropImg(img: Img, box: Box, margin: number): { img: Img; x: number; y: number } {
  const x0 = Math.max(0, Math.floor(box.x - margin));
  const y0 = Math.max(0, Math.floor(box.y - margin));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w + margin));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h + margin));
  const w = x1 - x0;
  const h = y1 - y0;
  if (x0 === 0 && y0 === 0 && w === img.width && h === img.height) return { img, x: 0, y: 0 };
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const start = ((y0 + y) * img.width + x0) * 4;
    out.set(img.rgba.subarray(start, start + w * 4), y * w * 4);
  }
  return { img: { rgba: out, width: w, height: h }, x: x0, y: y0 };
}

/** Spread (standard deviation) of brightness inside a box. */
function contrast(img: Img, b: Box): number {
  const x0 = Math.max(0, Math.floor(b.x));
  const y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(img.width, Math.ceil(b.x + b.w));
  const y1 = Math.min(img.height, Math.ceil(b.y + b.h));
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      const l = 0.299 * img.rgba[i]! + 0.587 * img.rgba[i + 1]! + 0.114 * img.rgba[i + 2]!;
      sum += l;
      sq += l * l;
      n++;
    }
  }
  if (n === 0) return 0;
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

/**
 * YuNet over a dehazed copy of `box`, at full resolution only (the faces smoke hides are small).
 * Only finds where the original is washed out count: in clear light the plain pass sees everything,
 * and what the dehazed copy adds there is a hand, a tattoo or a printed face.
 */
async function hazyFaces(img: Img, box: Box, modelsDir: string): Promise<Person[]> {
  const part = cropImg(img, box, 128);
  const found = await yunet(dehaze(part.img), { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, modelsDir);
  return found
    .map((f) => ({
      ...f,
      from: 'dehazed' as const,
      box: { ...f.box, x: f.box.x + part.x, y: f.box.y + part.y },
      landmarks: f.landmarks.map((p) => ({ x: p.x + part.x, y: p.y + part.y })),
    }))
    .filter((f) => centreIn(f.box, box) && contrast(img, f.box) < HAZE_CONTRAST);
}

/**
 * YuNet over a pyramid. Find all faces looks at full-resolution 640 px tiles and the whole photo at
 * 640 px: on a 24 MP photo a face of 150-600 px is cut by the tile edges and only ~15 px in the
 * whole-photo pass. Copies at 2560 and 1280 px see those faces whole.
 */
async function yunetPyramid(
  img: Img,
  region: Rect,
  modelsDir: string,
  scoreThreshold: number,
): Promise<Person[]> {
  const longest = Math.max(img.width, img.height);
  const levels = [Infinity, 2560, 1280].filter((edge) => edge === Infinity || edge < longest / 1.5);
  const all: Person[] = [];
  for (const edge of levels) {
    const found = await yunet(img, region, modelsDir, edge, scoreThreshold);
    // The shrunk copies are there for big faces the tiles cut apart; small finds there are mostly
    // noise (a hand, a dark patch), and the full-resolution tiles see small faces anyway.
    const scale = edge === Infinity ? 1 : edge / longest;
    all.push(...found.filter((f) => edge === Infinity || Math.max(f.box.w, f.box.h) * scale >= 40));
  }
  const kept = withoutFragments(nonMaximumSuppression(all, 0.4));
  // Find all faces' tile merge can join two neighbouring faces into one tall or wide box. When
  // another face fills a good part of it, the box is that pair, not a face.
  return kept.filter((f) => {
    const ratio = f.box.h / f.box.w;
    if (ratio <= 1.55 && ratio >= 0.65) return true;
    return !kept.some((o) => o !== f && overlap(o.box, f.box) >= 0.35 * area(f.box));
  });
}

/**
 * Drop detections far bigger than the crowd's (a drum skin, a face "seen" in flare smoke): over 5x
 * the median area, unless the other kind of detection (a head for a face, a face for a head) found
 * something of a matching size there. Only with enough detections for the median to mean
 * something.
 */
function notOversized(people: Person[], witnesses: readonly Person[]): Person[] {
  if (people.length < 8) return people;
  const median = people.map((p) => area(p.box)).sort((a, b) => a - b)[people.length >> 1]!;
  return people.filter((d) => {
    if (area(d.box) <= 5 * median) return true;
    return witnesses.some((o) => {
      if (o.kind === d.kind) return false;
      const shared = overlap(d.box, o.box);
      const ratio = area(d.box) / area(o.box);
      return (
        shared > 0 &&
        ratio <= 4 &&
        ratio >= 0.25 &&
        shared >= 0.15 * Math.max(area(d.box), area(o.box)) &&
        shared >= 0.5 * Math.min(area(d.box), area(o.box))
      );
    });
  });
}

/**
 * Drop detections that are really a hand (a raised fist): mostly inside a detected hand box. A face
 * with a hand over the mouth stays, since most of its box is outside the hand. So does a face
 * DEIMv2 also calls a face (it sometimes calls a face behind a fist a hand too), and a face YuNet is
 * sure of (0.8 and up).
 */
function notHands(people: Person[], hands: readonly Box[], faces: readonly Box[]): Person[] {
  return people.filter((p) => {
    if (faces.some((f) => overlap(f, p.box) >= 0.5 * Math.min(area(p.box), area(f)))) return true;
    if (p.from === 'yunet' && p.score >= 0.8) return true;
    return !hands.some((h) => overlap(p.box, h) >= 0.5 * area(p.box));
  });
}

/**
 * Faces that clash: a face mostly (50%+) covered by stronger faces is a stray box between people,
 * and a big face holding the centres of two or more smaller faces is a loose box over several
 * people. What is left goes through `onePerPerson`.
 */
function oneFacePerPerson(faces: Person[]): Person[] {
  const loose = faces.filter(
    (d) =>
      faces.filter((o) => o !== d && area(o.box) < area(d.box) / 2 && centreIn(o.box, d.box))
        .length >= 2,
  );
  const rest = faces.filter((d) => !loose.includes(d));
  const kept = rest.filter((d) => {
    const covered = rest
      .filter((o) => o !== d && o.score > d.score && area(o.box) < 4 * area(d.box))
      .reduce((sum, o) => sum + overlap(d.box, o.box), 0);
    return covered < 0.5 * area(d.box);
  });
  return onePerPerson(kept);
}

/**
 * One detection per person. Largest first, a detection mostly (60%+) inside a kept one, or
 * overlapping it by IoU 0.45+, is the same person when the kept one is at most 4x its area: it is
 * dropped, and the kept one takes its confirmation, landmarks and eyes. A loose box over two people
 * (more than 4x a face) keeps both.
 */
function onePerPerson(people: Person[]): Person[] {
  const kept: Person[] = [];
  for (const d of [...people].sort((a, b) => area(b.box) - area(a.box))) {
    const k = kept.findIndex(
      (o) =>
        overlap(d.box, o.box) > 0 &&
        area(o.box) <= 4 * area(d.box) &&
        (inside(d.box, o.box) || iou(d.box, o.box) >= 0.45),
    );
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

/**
 * The people in `region` (normalized): every face, and the heads with no face of their own (the
 * back of a head, a balaclava).
 */
export async function findPeople(img: Img, region: Rect, modelsDir: string): Promise<Person[]> {
  const x0 = clamp(Math.floor(region.x * img.width), 0, img.width);
  const y0 = clamp(Math.floor(region.y * img.height), 0, img.height);
  const x1 = clamp(Math.ceil((region.x + region.w) * img.width), x0, img.width);
  const y1 = clamp(Math.ceil((region.y + region.h) * img.height), y0, img.height);
  const px = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (px.w <= 0 || px.h <= 0) return [];
  // Heads come out the same size whatever was selected: the area is looked at as part of a copy of
  // the whole photo at most 2560 px long.
  const maxEdge = (2560 * Math.max(px.w, px.h)) / Math.max(img.width, img.height);
  // DEIMv2-S once over the whole area, and the ~8x cheaper DEIMv2-N in tiles for the heads too
  // small for that (in smoke, half hidden by a fist).
  const found = await deimv2(img, px, await outlineModel(modelsDir, 'heads'), maxEdge, false, true);
  const more = await deimv2(
    img,
    px,
    await outlineModel(modelsDir, 'smallHeads'),
    maxEdge,
    true,
    false,
  );
  const heads = [
    ...found.heads,
    ...more.heads.filter(
      (h) => !found.heads.some((k) => iou(h.box, k.box) > 0.3 || inside(h.box, k.box)),
    ),
  ];
  // Faces anchor people: their boxes are tight, where head boxes in a crowd are loose and overlap
  // the neighbours. YuNet goes down to 0.4, since a partly hidden face (behind a hand, a flag edge,
  // another head) scores low, but a weak face counts only where a head sits around it.
  const plain = (await yunetPyramid(img, region, modelsDir, WEAK_FACE)).filter(
    (f) => f.score >= 0.6 || heads.some((h) => holdsFace(h, f)),
  );
  // Flare smoke washes faces out; a pass over a dehazed copy finds them again.
  const hazy = (await hazyFaces(img, px, modelsDir)).filter(
    (f) => !plain.some((p) => overlap(p.box, f.box) > 0.3 * Math.min(area(p.box), area(f.box))),
  );
  const deimFaces = [...found.faces, ...more.faces];
  const faces = oneFacePerPerson([
    ...plain,
    ...hazy,
    ...deimFaces.map((box): Person => ({
      box,
      score: 0.5,
      landmarks: [],
      kind: 'face',
      from: 'deimv2',
      confirmed: true,
    })),
  ]);
  // Heads add the people with no visible face. A head with a face inside is that person (already
  // in) or a loose box over several; either way it goes.
  // A faceless head scoring low is mostly an arm or a shoulder; with eyes inside it is a balaclava,
  // whose eyeholes get covered.
  const eyes = [...found.eyes, ...more.eyes];
  const lone = heads
    .filter(
      (h) =>
        !faces.some((f) => centreIn(f.box, h.box)) &&
        (h.score >= LONE_HEAD_SCORE || eyes.some((e) => inside(e, h.box))) &&
        !faces.some((f) => overlap(f.box, h.box) > CLIP * area(f.box)),
    )
    .map((h): Person => {
      const own = eyes.filter((e) => inside(e, h.box));
      return own.length > 0 ? { ...h, eyes: own } : h;
    });
  const hands = [...found.hands, ...more.hands];
  const kept = notOversized([...faces, ...lone], [...heads, ...faces]);
  return onePerPerson(notHands(kept, hands, deimFaces));
}
