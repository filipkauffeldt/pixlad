// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Retouch areas and face geometry, adapted from editing-experiment's retouch-areas.ts and
// retouch-geometry.ts (GPL-3.0-or-later), without lens correction.
import { clamp, pointInPolygon, rectToPolygon, shapeBounds } from '../shared/geometry';
import { blockSizePxToRel } from '../shared/block-size';
import type { MosaicArea, MosaicOp, Rect, Shape } from '../shared/types';

export type RetouchMode = 'add' | 'subtract';

export interface RetouchArea {
  kind: 'rect' | 'lasso' | 'face';
  mode: RetouchMode;
  /** An area that is off stays in the list so it can be switched on again. */
  enabled: boolean;
  shape?: Shape;
  /** The raw detector box; its outline follows the padding slider. */
  face?: { box: Rect; score?: number };
}

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

export function areaShape(area: RetouchArea, facePadding: number): Shape {
  if (area.face) return padFaceBox(area.face.box, facePadding);
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
  detections: readonly { box: Rect; score?: number }[],
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
      face: { box: found.box, ...(found.score === undefined ? {} : { score: found.score }) },
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

/** The strip around the picture where a drag may start, in CSS pixels. */
export const HIT_MARGIN = 40;

export const clampToPicture = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: clamp(p.x, 0, 1),
  y: clamp(p.y, 0, 1),
});

export const isOnPicture = (p: { x: number; y: number }): boolean =>
  p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
