// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Retouch areas and face geometry, adapted from editing-experiment's retouch-areas.ts and
// retouch-geometry.ts (GPL-3.0-or-later), without lens correction.
import { clamp, pointInPolygon, rectToPolygon, shapeBounds } from '../shared/geometry';
import { blockSizePxToRel } from '../shared/block-size';
import type {
  MosaicArea,
  MosaicOp,
  NormalizedFaceTraits,
  Point,
  Polygon,
  Rect,
  Shape,
} from '../shared/types';

export type RetouchMode = 'add' | 'subtract';

export interface RetouchArea {
  kind: 'rect' | 'lasso' | 'face';
  mode: RetouchMode;
  /** An area that is off stays in the list so it can be switched on again. */
  enabled: boolean;
  shape?: Shape;
  /** The raw detector box; its outline follows the padding slider. */
  face?: FaceData;
}

/** A detection as kept in an area. */
export interface FaceData extends NormalizedFaceTraits {
  /** How the face is covered. Missing in older sessions: a rectangle. */
  shape?: FaceShape;
  /** The traced outline of face and hair, normalized. */
  outline?: Point[];
}

export type FaceShape = 'rectangle' | 'oval' | 'outline';

/**
 * Padding around a detected face, as a fraction of its width. Height padding is 1.4x wider and
 * biased upward (65% above, 35% below) so hair and chins are covered.
 */
const FACE_PADDING_VERTICAL = 1.4;
const FACE_PADDING_UP_BIAS = 0.65;

export function padFaceBox(box: Rect, padding: number): Rect {
  const horizontal = Math.max(0, box.w * padding);
  const vertical = Math.max(0, box.h * padding * FACE_PADDING_VERTICAL);
  const up = vertical * FACE_PADDING_UP_BIAS;
  const left = clamp(box.x - horizontal, 0, 1);
  const top = clamp(box.y - up, 0, 1);
  const right = clamp(box.x + box.w + horizontal, left, 1);
  const bottom = clamp(box.y + box.h + vertical - up, top, 1);
  return { type: 'rect', x: left, y: top, w: right - left, h: bottom - top };
}

const OVAL_EXPONENT = 2.5;
const OVAL_POINTS = 48;

/**
 * A superellipse, |x/a|^2.5 + |y/b|^2.5 = 1, rotated by `angle`. Rounder than a box, fuller than an
 * ellipse. Worked out with x in pixel proportions (normalized x times `aspect`).
 */
function superellipse(
  cx: number,
  cy: number,
  a: number,
  b: number,
  angle: number,
  aspect: number,
): Polygon {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const power = 2 / OVAL_EXPONENT;
  const points = Array.from({ length: OVAL_POINTS }, (_, i) => {
    const t = (2 * Math.PI * i) / OVAL_POINTS;
    const u = a * Math.sign(Math.cos(t)) * Math.abs(Math.cos(t)) ** power;
    const v = b * Math.sign(Math.sin(t)) * Math.abs(Math.sin(t)) ** power;
    return {
      x: clamp((cx + u * cos - v * sin) / aspect, 0, 1),
      y: clamp(cy + u * sin + v * cos, 0, 1),
    };
  });
  return { type: 'polygon', points };
}

/** How far (dx, dy) lies along a superellipse with half-axes a and b: 1 is on its edge. */
const ovalDistance = (dx: number, dy: number, a: number, b: number): number =>
  (Math.abs(dx / a) ** OVAL_EXPONENT + Math.abs(dy / b) ** OVAL_EXPONENT) ** (1 / OVAL_EXPONENT);

/**
 * An oval in the padded box around a face, tilted with the head. The padding is the same as for
 * the rectangle: 1.4x vertically, mostly upward. The oval grows until every corner of the detector
 * box is inside, so it never covers less of the face than the rectangle.
 */
export function faceOval(face: FaceData, padding: number): Polygon {
  const aspect = face.aspect ?? 1;
  const angle = face.angle ?? 0;
  const w = face.box.w * aspect;
  const h = face.box.h;
  // A head box already holds hair and ears: padded evenly.
  if (face.kind === 'head') {
    const cx = (face.box.x + face.box.w / 2) * aspect;
    const cy = face.box.y + face.box.h / 2;
    return superellipse(cx, cy, (w / 2) * (1 + padding), (h / 2) * (1 + padding), angle, aspect);
  }
  const horizontal = w * padding;
  const vertical = h * padding * FACE_PADDING_VERTICAL;
  const up = vertical * FACE_PADDING_UP_BIAS;
  const a = w / 2 + horizontal;
  const b = (h + vertical) / 2;
  // The padding is uneven, so the oval's centre sits above the box's, along the head's axis.
  const shift = (vertical - up) / 2 - up / 2;
  const grow = Math.max(
    1,
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sy) => ovalDistance((sx * w) / 2, (sy * h) / 2 - shift, a, b)),
    ),
  );
  const cx = (face.box.x + face.box.w / 2) * aspect - shift * Math.sin(angle);
  const cy = face.box.y + face.box.h / 2 + shift * Math.cos(angle);
  return superellipse(cx, cy, a * grow, b * grow, angle, aspect);
}

/** A head box padded evenly: it already holds hair and ears. */
function padHeadBox(box: Rect, padding: number): Rect {
  const left = clamp(box.x - (box.w * padding) / 2, 0, 1);
  const top = clamp(box.y - (box.h * padding) / 2, 0, 1);
  const right = clamp(box.x + box.w * (1 + padding / 2), left, 1);
  const bottom = clamp(box.y + box.h * (1 + padding / 2), top, 1);
  return { type: 'rect', x: left, y: top, w: right - left, h: bottom - top };
}

/** A traced outline grown from its centre by the padding. */
function grownOutline(outline: readonly Point[], padding: number): Polygon {
  let cx = 0;
  let cy = 0;
  for (const p of outline) {
    cx += p.x / outline.length;
    cy += p.y / outline.length;
  }
  return {
    type: 'polygon',
    points: outline.map((p) => ({
      x: clamp(cx + (p.x - cx) * (1 + padding), 0, 1),
      y: clamp(cy + (p.y - cy) * (1 + padding), 0, 1),
    })),
  };
}

export function faceShape(face: FaceData, padding: number): Shape {
  switch (face.shape ?? 'rectangle') {
    case 'rectangle':
      return face.kind === 'head' ? padHeadBox(face.box, padding) : padFaceBox(face.box, padding);
    case 'oval':
      return faceOval(face, padding);
    case 'outline':
      // Not traced (yet, or too small): the oval.
      return face.outline && face.outline.length >= 3
        ? grownOutline(face.outline, padding)
        : faceOval(face, padding);
  }
}

export function areaShape(area: RetouchArea, facePadding: number): Shape {
  if (area.face) return faceShape(area.face, facePadding);
  if (!area.shape) throw new Error('a retouch area has neither a shape nor a face');
  return area.shape;
}

export function opFromAreas(
  areas: readonly RetouchArea[],
  blockPx: number,
  facePadding: number,
  longEdge: number,
): MosaicOp {
  return {
    blockSizeRel: blockSizePxToRel(blockPx, longEdge),
    areas: areas.map((area): MosaicArea => ({
      shape: areaShape(area, facePadding),
      ...(area.mode === 'subtract' ? { mode: 'subtract' as const } : {}),
      ...(area.enabled ? {} : { enabled: false }),
      ...(area.face ? { face: area.face } : {}),
    })),
  };
}

/** The topmost area (last drawn) whose outline holds the point, or -1. */
export function areaIndexAt(
  areas: readonly RetouchArea[],
  point: { x: number; y: number },
  facePadding: number,
): number {
  for (let i = areas.length - 1; i >= 0; i--) {
    const shape = areaShape(areas[i]!, facePadding);
    const inside =
      shape.type === 'rect'
        ? point.x >= shape.x &&
          point.x <= shape.x + shape.w &&
          point.y >= shape.y &&
          point.y <= shape.y + shape.h
        : pointInPolygon(point, shape.points);
    if (inside) return i;
  }
  return -1;
}

export function countAreas(areas: readonly RetouchArea[]): {
  faces: { on: number; total: number };
  drawn: { on: number; total: number };
} {
  const count = (list: readonly RetouchArea[]): { on: number; total: number } => ({
    on: list.filter((a) => a.enabled).length,
    total: list.length,
  });
  return {
    faces: count(areas.filter((a) => a.face)),
    drawn: count(areas.filter((a) => !a.face)),
  };
}

const centre = (box: Rect): { x: number; y: number } => ({
  x: box.x + box.w / 2,
  y: box.y + box.h / 2,
});

/** The faces whose box centre lies inside a lasso: faces beside the outline are dropped. */
export function facesInLasso<T extends { box: Rect }>(
  faces: readonly T[],
  lasso: readonly { x: number; y: number }[],
): T[] {
  return faces.filter((face) => pointInPolygon(centre(face.box), lasso));
}

/** New detections added; a face already found (its box holds the new centre) is not added twice. */
export function withDetectedFaces(
  areas: readonly RetouchArea[],
  detections: readonly FaceData[],
  mode: RetouchMode,
): RetouchArea[] {
  const known = areas.flatMap((a) => (a.face ? [a.face.box] : []));
  const fresh = detections.filter((found) => {
    const c = centre(found.box);
    return !known.some((b) => c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h);
  });
  return [
    ...areas,
    ...fresh.map((found): RetouchArea => ({
      kind: 'face',
      mode,
      enabled: true,
      face: { ...found },
    })),
  ];
}

/** The areas without the detected faces whose centre lies inside `region`. Drawn areas stay. */
export function withoutFacesInside(areas: readonly RetouchArea[], region: Shape): RetouchArea[] {
  const outline = (region.type === 'rect' ? rectToPolygon(region) : region).points;
  return areas.filter((a) => !(a.face && pointInPolygon(centre(a.face.box), outline)));
}

export type Outline = 'rect' | 'lasso';

/** Which temporary flips are held: Alt swaps rectangle and lasso, Ctrl (⌘ on a Mac) add and subtract. */
export interface Flips {
  outline: boolean;
  mode: boolean;
}

/**
 * The flips a pointer or key event holds. AltGr (Ctrl+Alt on Windows/Linux, or the AltGraph
 * modifier) types characters on a Swedish keyboard and must never count.
 */
export function flipsHeld(
  event: {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    getModifierState?: (key: 'AltGraph') => boolean;
  },
  isMac: boolean,
): Flips {
  if (event.getModifierState?.('AltGraph') === true) return { outline: false, mode: false };
  return { outline: event.altKey, mode: isMac ? event.metaKey : event.ctrlKey };
}

/** The outline and mode a drag would use: the chosen ones, with any held flips applied. */
export function withFlips(
  chosen: { outline: Outline; mode: RetouchMode },
  flips: Flips,
): { outline: Outline; mode: RetouchMode } {
  return {
    outline: flips.outline ? (chosen.outline === 'rect' ? 'lasso' : 'rect') : chosen.outline,
    mode: flips.mode ? (chosen.mode === 'add' ? 'subtract' : 'add') : chosen.mode,
  };
}

export const areaBounds = (area: RetouchArea, facePadding: number): Rect =>
  shapeBounds(areaShape(area, facePadding));

/** The room kept beside and above the picture when it is fitted to the stage, in CSS pixels. */
export const FIT_MARGIN = 40;
export const FIT_TOP = 24;

/**
 * The room kept under the fitted picture: the edit bar sits there, 10 px from the picture and
 * 10 px from the thumbnails (6 px to the stage's edge, and the thumbnails' 4 px inset).
 */
export const EDIT_BAR_HEIGHT = 22;
export const FIT_BOTTOM = 10 + EDIT_BAR_HEIGHT + 6;

/** The strip around the picture where a drag may start, in CSS pixels. */
export const HIT_MARGIN = 100;

/** Whether a point (unit picture coordinates) is on the picture or in the strip around it. */
export const isNearPicture = (p: { x: number; y: number }, w: number, h: number): boolean =>
  p.x * w >= -HIT_MARGIN &&
  p.x * w <= w + HIT_MARGIN &&
  p.y * h >= -HIT_MARGIN &&
  p.y * h <= h + HIT_MARGIN;

export const clampToPicture = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: clamp(p.x, 0, 1),
  y: clamp(p.y, 0, 1),
});

export const isOnPicture = (p: { x: number; y: number }): boolean =>
  p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
