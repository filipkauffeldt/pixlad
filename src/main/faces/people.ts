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
  from: 'yunet' | 'deimv2';
  /** A detector saw a face here. */
  confirmed?: boolean;
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

const area = (b: Box): number => b.w * b.h;

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

/** YuNet as Find all faces runs it. Boxes in `img` pixels. */
async function yunet(img: Img, region: Rect, modelsDir: string): Promise<Person[]> {
  const found = await detectFaces(img.rgba, img.width, img.height, region, {
    modelPath: join(modelsDir, YUNET),
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
  // the neighbours.
  const faces = await yunet(img, region, modelsDir);
  // Heads add the people with no visible face. A head with a face inside is that person (already
  // in) or a loose box over several; either way it goes.
  const lone = heads.filter(
    (h) =>
      !faces.some((f) => centreIn(f.box, h.box)) &&
      h.score >= LONE_HEAD_SCORE &&
      !faces.some((f) => overlap(f.box, h.box) > CLIP * area(f.box)),
  );
  return [...faces, ...lone];
}
