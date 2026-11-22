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

export type FaceKind = 'face' | 'head';

export interface FaceTraits<TBox> {
  /** The raw detector box, before padding. */
  box: TBox;
  score?: number;
  landmarks?: Point[];
  /** Head roll in radians, in pixel space, from the eye landmarks. */
  angle?: number;
  /** A head box holds hair and ears; a face box does not. Default: face. */
  kind?: FaceKind;
  confirmed?: boolean;
  /** Eyes inside a head with no face of its own: a balaclava's eyeholes. */
  eyes?: TBox[];
}

export interface NormalizedFaceTraits extends FaceTraits<Rect> {
  aspect?: number;
}

export type MosaicFace = Pick<FaceTraits<Rect>, 'box' | 'score'>;

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

export interface FaceDetection extends NormalizedFaceTraits {
  score: number;
}

export interface DetectOptions {
  people?: boolean;
}

export type TraceFace = Pick<FaceTraits<Rect>, 'box' | 'kind' | 'angle' | 'confirmed' | 'eyes'>;

export const isAdded = (area: MosaicArea): boolean =>
  area.enabled !== false && area.mode !== 'subtract';

export const opHasAddedArea = (op: MosaicOp): boolean => op.areas.some(isAdded);
