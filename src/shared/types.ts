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
  /** Head roll in radians, in pixel space, from the eye landmarks. */
  angle?: number;
  /** Photo width / height, to draw tilted shapes in normalized coordinates. */
  aspect?: number;
  /** A head box holds hair and ears; a face box does not. Default: face. */
  kind?: 'face' | 'head';
  /** A detector saw a face here (for heads: not only a head). */
  confirmed?: boolean;
  /** Eyes inside a head with no face of its own: a balaclava's eyeholes. */
  eyes?: Rect[];
}

export interface DetectOptions {
  /**
   * Also find heads (turned away, in balaclavas) and faces in crowds and flare smoke, for the
   * Outlines face shape. Slower.
   */
  people?: boolean;
}

/** A face to trace an outline for: its normalized box, kind and roll. */
export interface TraceFace {
  box: Rect;
  /** A head box holds hair and ears; a face box does not. Default: face. */
  kind?: 'face' | 'head';
  angle?: number;
  /** A detector saw a face here. Default: true for a face, false for a head. */
  confirmed?: boolean;
  /** Eyes inside a head with no face of its own: a balaclava's eyeholes. */
  eyes?: Rect[];
}

export const isAdded = (area: MosaicArea): boolean =>
  area.enabled !== false && area.mode !== 'subtract';

/** Whether the op puts any mosaic on the picture. */
export const opHasAddedArea = (op: MosaicOp): boolean => op.areas.some(isAdded);
