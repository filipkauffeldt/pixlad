// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Geometry and mosaic types, adapted from editing-experiment (GPL-3.0-or-later).

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  type: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Polygon {
  type: 'polygon';
  points: Point[];
}
/** Shapes are in normalized (0..1) coordinates of the oriented image. */
export type Shape = Rect | Polygon;

export interface MosaicFace {
  /** The raw detector box in normalized coordinates; padding is applied on top. */
  box: Rect;
  score?: number;
}

/** One entry of the ordered area list: an add covers its shape, a subtract takes mosaic away. */
export interface MosaicArea {
  shape: Shape;
  mode?: 'add' | 'subtract';
  enabled?: boolean;
  face?: MosaicFace;
}

export interface MosaicOp {
  areas: MosaicArea[];
  /** Block edge relative to the longer image edge. */
  blockSizeRel: number;
}

export interface FaceDetection {
  box: Rect;
  score: number;
  landmarks?: Point[];
}

export const isAdded = (area: MosaicArea): boolean =>
  area.enabled !== false && area.mode !== 'subtract';

/** Whether the op puts any mosaic on the picture. */
export const opHasAddedArea = (op: MosaicOp): boolean => op.areas.some(isAdded);
