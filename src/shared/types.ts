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
  /** Experimental: a head detector's box holds hair and ears; a face box does not. */
  kind?: 'face' | 'head';
  /** Experimental: head roll in radians, in pixel space (from the eye landmarks). */
  angle?: number;
  /** Experimental: photo width / height, to draw tilted ovals in normalized coordinates. */
  aspect?: number;
  /** Experimental: a traced outline (face mesh or face skin), normalized. */
  outline?: Point[];
}

/** Experimental detector and outline picker, for trying the options out. */
export const FACE_DETECTORS = [
  { id: 'yunet', label: 'YuNet (today)' },
  { id: 'yolo-n', label: 'YOLOv8n-face' },
  { id: 'yolo-s', label: 'YOLOv8s-face' },
  { id: 'deim-n', label: 'DEIMv2-N heads' },
  { id: 'deim-s', label: 'DEIMv2-S heads (slow)' },
  { id: 'hybrid', label: 'DEIMv2-S heads, 1 pass + YuNet' },
] as const;
export type FaceDetector = (typeof FACE_DETECTORS)[number]['id'];

export const FACE_STYLES = [
  { id: 'box', label: 'Box' },
  { id: 'oval', label: 'Oval' },
  { id: 'tilt', label: 'Tilted oval' },
  { id: 'mesh', label: 'Face mesh outline' },
  { id: 'skin', label: 'Face skin only' },
] as const;
export type FaceStyle = (typeof FACE_STYLES)[number]['id'];

export interface DetectOptions {
  detector: FaceDetector;
  style: FaceStyle;
}

export const isAdded = (area: MosaicArea): boolean =>
  area.enabled !== false && area.mode !== 'subtract';

/** Whether the op puts any mosaic on the picture. */
export const opHasAddedArea = (op: MosaicOp): boolean => op.areas.some(isAdded);
