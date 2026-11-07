// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { Point, Polygon, Rect, Shape } from './types';

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(point: Point, points: readonly Point[]): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!;
    const b = points[i]!;
    if (b.y > point.y !== a.y > point.y) {
      const x = ((a.x - b.x) * (point.y - b.y)) / (a.y - b.y) + b.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

export function rectToPolygon(rect: Rect): Polygon {
  return {
    type: 'polygon',
    points: [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ],
  };
}

export function polygonBounds(points: readonly Point[]): Rect {
  if (points.length === 0) return { type: 'rect', x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { type: 'rect', x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export const shapeBounds = (shape: Shape): Rect =>
  shape.type === 'rect' ? shape : polygonBounds(shape.points);

export function shapesBounds(shapes: readonly Shape[]): Rect | undefined {
  let bounds: Rect | undefined;
  for (const shape of shapes) {
    const next = shapeBounds(shape);
    if (next.w <= 0 || next.h <= 0) continue;
    if (!bounds) {
      bounds = { ...next };
    } else {
      const x = Math.min(bounds.x, next.x);
      const y = Math.min(bounds.y, next.y);
      const right = Math.max(bounds.x + bounds.w, next.x + next.w);
      const bottom = Math.max(bounds.y + bounds.h, next.y + next.h);
      bounds = { type: 'rect', x, y, w: right - x, h: bottom - y };
    }
  }
  return bounds;
}

function squaredDistanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (point.x - a.x) ** 2 + (point.y - a.y) ** 2;
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return (point.x - (a.x + t * dx)) ** 2 + (point.y - (a.y + t * dy)) ** 2;
}

/** Ramer-Douglas-Peucker for an open polyline; endpoints are kept. */
export function simplifyPolyline(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestSquared = 0;
    for (let i = first + 1; i < last; i++) {
      const d = squaredDistanceToSegment(points[i]!, points[first]!, points[last]!);
      if (d > farthestSquared) {
        farthestSquared = d;
        farthest = i;
      }
    }
    if (farthest !== -1 && farthestSquared > epsilon * epsilon) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}

/** Simplify a closed ring. */
export function simplifyPolygon(points: readonly Point[], epsilon: number): Point[] {
  if (points.length <= 3) return points.map((p) => ({ ...p }));
  let farthest = 0;
  let farthestSquared = -1;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i]!.x - points[0]!.x) ** 2 + (points[i]!.y - points[0]!.y) ** 2;
    if (d > farthestSquared) {
      farthestSquared = d;
      farthest = i;
    }
  }
  const a = simplifyPolyline(points.slice(0, farthest + 1), epsilon);
  const b = simplifyPolyline([...points.slice(farthest), points[0]!], epsilon);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
