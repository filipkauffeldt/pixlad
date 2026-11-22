// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Derived from editing-experiment apps/desktop/src/renderer/view-transform.ts (GPL-3.0-or-later).
import { clamp } from '../shared/geometry';
import type { Point } from '../shared/types';

export interface Size {
  width: number;
  height: number;
}

export type ImagePoint = Point;
export type ScreenPoint = Point;
export type UnitPoint = Point;

type CssPixelsPerImagePixel = number;
type DevicePixelsPerImagePixel = number;

/**
 * Where the picture sits in the viewport: `css = offset + scale * image`, with `offset` the CSS
 * position of the picture's top-left corner.
 */
export interface ViewLayout {
  scale: CssPixelsPerImagePixel;
  offset: Point;
}

/**
 * `scale: null` is Fit, the caller's layout at any window size. `pan` is the CSS-pixel distance of
 * the picture's centre from where Fit puts it.
 */
export interface ZoomView {
  scale: CssPixelsPerImagePixel | null;
  pan: Point;
}

export const FIT_VIEW: ZoomView = { scale: null, pan: { x: 0, y: 0 } };

export const ZOOM_LEVELS: readonly DevicePixelsPerImagePixel[] = [0.5, 1, 2];
export const DEFAULT_ZOOM_LEVEL: DevicePixelsPerImagePixel = 1;
export const MAX_ZOOM: DevicePixelsPerImagePixel = 8;
export const ZOOM_STEP = 1.25;
export const PAN_MARGIN_CSS_PX = 64;

const MIN_DPR = 0.01;
const FIT_SNAP_RATIO = 1.002;
const GRID_TOLERANCE = 1e-6;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const LINE_HEIGHT_PX = 33;
const PAGE_HEIGHT_PX = 100;
const MOUSE_NOTCH_PX = 100;
const MIN_MOUSE_NOTCH_PX = 50;
const MAX_WHEEL_DELTA_PX = 120;
const PINCH_ZOOM_PER_PX = 0.01;

const scaledSize = (image: Size, scale: CssPixelsPerImagePixel): Size => ({
  width: image.width * scale,
  height: image.height * scale,
});

const centreOf = (offset: Point, size: Size): Point => ({
  x: offset.x + size.width / 2,
  y: offset.y + size.height / 2,
});

export function viewLayout(
  view: ZoomView,
  base: ViewLayout,
  image: Size,
  dpr?: number,
): ViewLayout {
  const layout = unsnappedLayout(view, base, image);
  return dpr === undefined || view.scale === null ? layout : snapToDevicePixels(layout, dpr);
}

// Zoom maths anchors here, not to the snapped layout, so rounding never accumulates in the pan.
function unsnappedLayout(view: ZoomView, base: ViewLayout, image: Size): ViewLayout {
  if (view.scale === null) return base;
  const centre = fitCentre(base, image);
  const size = scaledSize(image, view.scale);
  return {
    scale: view.scale,
    offset: {
      x: centre.x + view.pan.x - size.width / 2,
      y: centre.y + view.pan.y - size.height / 2,
    },
  };
}

// Off the device pixel grid the texture filter blends neighbours (grey columns at 1:1). Other
// scales have no grid to land on. The offset is relative to the stage, whose corner is on the grid.
export function snapToDevicePixels(layout: ViewLayout, dpr: number): ViewLayout {
  const devicePixelsPerImagePixel = layout.scale * dpr;
  const isHalf = Math.abs(devicePixelsPerImagePixel - 0.5) < GRID_TOLERANCE;
  const whole = Math.round(devicePixelsPerImagePixel);
  const isWhole = whole >= 1 && Math.abs(devicePixelsPerImagePixel - whole) < GRID_TOLERANCE;
  if (!isHalf && !isWhole) return layout;
  const snap = (css: number): number => Math.round(css * dpr) / dpr;
  return {
    scale: (isHalf ? 0.5 : whole) / dpr,
    offset: { x: snap(layout.offset.x), y: snap(layout.offset.y) },
  };
}

export const wholeDevicePixels = (css: number, dpr: number): number =>
  Math.floor(css * dpr + GRID_TOLERANCE) / dpr;

export const fitCentre = (base: ViewLayout, image: Size): Point =>
  centreOf(base.offset, scaledSize(image, base.scale));

export const imageToScreen = (layout: ViewLayout, point: ImagePoint): ScreenPoint => ({
  x: layout.offset.x + point.x * layout.scale,
  y: layout.offset.y + point.y * layout.scale,
});

export const screenToImage = (layout: ViewLayout, point: ScreenPoint): ImagePoint => ({
  x: (point.x - layout.offset.x) / layout.scale,
  y: (point.y - layout.offset.y) / layout.scale,
});

function clampPanAxis(
  pan: number,
  fitCentreAt: number,
  pictureExtent: number,
  viewportExtent: number,
): number {
  if (pictureExtent <= viewportExtent) return 0;
  const half = pictureExtent / 2;
  const centreMin = viewportExtent - half - PAN_MARGIN_CSS_PX;
  const centreMax = half + PAN_MARGIN_CSS_PX;
  const centreAt = clamp(fitCentreAt + pan, centreMin, centreMax);
  return centreAt - fitCentreAt;
}

export function clampPan(
  pan: Point,
  scale: CssPixelsPerImagePixel,
  base: ViewLayout,
  image: Size,
  viewport: Size,
): Point {
  const centre = fitCentre(base, image);
  const size = scaledSize(image, scale);
  return {
    x: clampPanAxis(pan.x, centre.x, size.width, viewport.width),
    y: clampPanAxis(pan.y, centre.y, size.height, viewport.height),
  };
}

export interface ZoomContext {
  base: ViewLayout;
  image: Size;
  viewport: Size;
  dpr: number;
}

export const levelScale = (level: DevicePixelsPerImagePixel, dpr: number): CssPixelsPerImagePixel =>
  level / Math.max(MIN_DPR, dpr);

export const scaleLimits = (
  context: ZoomContext,
): { min: CssPixelsPerImagePixel; max: CssPixelsPerImagePixel } => ({
  min: context.base.scale,
  max: Math.max(context.base.scale, levelScale(MAX_ZOOM, context.dpr)),
});

export const zoomPercent = (scale: CssPixelsPerImagePixel, dpr: number): number =>
  scale * dpr * 100;

const scaleAbout = (anchor: ScreenPoint, point: ScreenPoint, ratio: number): ScreenPoint => ({
  x: anchor.x - (anchor.x - point.x) * ratio,
  y: anchor.y - (anchor.y - point.y) * ratio,
});

export function zoomTo(
  view: ZoomView,
  context: ZoomContext,
  anchor: ScreenPoint,
  scale: CssPixelsPerImagePixel,
): ZoomView {
  const { min, max } = scaleLimits(context);
  const next = clamp(scale, min, max);
  if (next <= min * FIT_SNAP_RATIO) return FIT_VIEW;
  const current = unsnappedLayout(view, context.base, context.image);
  const offset = scaleAbout(anchor, current.offset, next / current.scale);
  const centre = centreOf(offset, scaledSize(context.image, next));
  const fit = fitCentre(context.base, context.image);
  const pan = { x: centre.x - fit.x, y: centre.y - fit.y };
  return {
    scale: next,
    pan: clampPan(pan, next, context.base, context.image, context.viewport),
  };
}

export function zoomBy(
  view: ZoomView,
  context: ZoomContext,
  anchor: ScreenPoint,
  factor: number,
): ZoomView {
  const current = unsnappedLayout(view, context.base, context.image);
  return zoomTo(view, context, anchor, current.scale * factor);
}

export function panBy(view: ZoomView, context: ZoomContext, delta: ScreenPoint): ZoomView {
  if (view.scale === null) return view;
  return {
    scale: view.scale,
    pan: clampPan(
      { x: view.pan.x + delta.x, y: view.pan.y + delta.y },
      view.scale,
      context.base,
      context.image,
      context.viewport,
    ),
  };
}

export function reclamp(view: ZoomView, context: ZoomContext): ZoomView {
  if (view.scale === null) return view;
  return zoomTo(view, context, fitCentre(context.base, context.image), view.scale);
}

export function overPicture(layout: ViewLayout, image: Size, point: ScreenPoint): boolean {
  const local = screenToImage(layout, point);
  return local.x >= 0 && local.y >= 0 && local.x <= image.width && local.y <= image.height;
}

export function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * LINE_HEIGHT_PX;
  if (deltaMode === DOM_DELTA_PAGE) return delta * PAGE_HEIGHT_PX;
  return delta;
}

export function wheelZoomFactor(event: { deltaY: number; deltaMode: number }): number {
  const pixels = wheelPixels(event.deltaY, event.deltaMode);
  const isMouseNotch = Math.abs(pixels) >= MIN_MOUSE_NOTCH_PX;
  const exponentPerPixel = isMouseNotch ? Math.log(ZOOM_STEP) / MOUSE_NOTCH_PX : PINCH_ZOOM_PER_PX;
  const clamped = clamp(pixels, -MAX_WHEEL_DELTA_PX, MAX_WHEEL_DELTA_PX);
  return Math.exp(-clamped * exponentPerPixel);
}

// Chromium on Linux and Windows can send Shift+wheel as a vertical delta.
export function wheelPanDelta(event: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}): ScreenPoint {
  const negateWithoutMinusZero = (value: number): number => (value === 0 ? 0 : -value);
  const x = wheelPixels(event.deltaX, event.deltaMode);
  const y = wheelPixels(event.deltaY, event.deltaMode);
  if (!event.shiftKey) return { x: negateWithoutMinusZero(x), y: negateWithoutMinusZero(y) };
  return { x: negateWithoutMinusZero(x !== 0 ? x : y), y: 0 };
}

export function screenToUnit(layout: ViewLayout, image: Size, point: ScreenPoint): UnitPoint {
  const local = screenToImage(layout, point);
  return { x: local.x / image.width, y: local.y / image.height };
}
