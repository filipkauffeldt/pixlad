import { describe, expect, it } from 'vitest';
import {
  clampPan,
  FIT_VIEW,
  fitCentre,
  imageToScreen,
  levelScale,
  overPicture,
  panBy,
  reclamp,
  scaleLimits,
  screenToImage,
  screenToUnit,
  snapToDevicePixels,
  viewLayout,
  wheelPanDelta,
  wheelPixels,
  wheelZoomFactor,
  wholeDevicePixels,
  zoomBy,
  zoomPercent,
  zoomTo,
} from '../src/renderer/view-transform';

const image = { width: 4000, height: 3000 };
const viewport = { width: 1000, height: 800 };
const base = { scale: 0.25, offset: { x: 0, y: 25 } };
const context = { base, image, viewport, dpr: 2 };
const pan = { x: 10.3, y: -4.7 };
const layout = { scale: 0.5, offset: { x: 12, y: -7 } };

describe('viewLayout', () => {
  it('is the base layout at Fit', () => {
    expect(viewLayout(FIT_VIEW, base, image, 2)).toEqual(base);
  });

  it('scales about the Fit centre and pans', () => {
    expect(viewLayout({ scale: 0.7, pan }, base, image)).toEqual({
      scale: 0.7,
      offset: { x: -889.7, y: -654.7 },
    });
  });

  it('snaps whole and half device-pixel scales to the device grid', () => {
    expect(viewLayout({ scale: 0.5, pan }, base, image, 2).offset).toEqual({
      x: -489.5,
      y: -354.5,
    });
    expect(viewLayout({ scale: 0.25, pan }, base, image, 2).offset).toEqual({ x: 10.5, y: 20.5 });
    expect(viewLayout({ scale: 1, pan }, base, image, 2).offset).toEqual({
      x: -1489.5,
      y: -1104.5,
    });
    expect(viewLayout({ scale: 1, pan }, base, image, 1).offset).toEqual({ x: -1490, y: -1105 });
  });

  it('leaves other scales smooth', () => {
    expect(viewLayout({ scale: 0.7, pan }, base, image, 2)).toEqual(
      viewLayout({ scale: 0.7, pan }, base, image),
    );
    expect(snapToDevicePixels({ scale: 0.5, offset: { x: 1.3, y: 2.6 } }, 1.5)).toEqual({
      scale: 0.5,
      offset: { x: 1.3, y: 2.6 },
    });
  });
});

describe('device pixels', () => {
  it('floors a CSS size to whole device pixels', () => {
    expect(wholeDevicePixels(10.3, 2)).toBe(10);
    expect(wholeDevicePixels(10.5, 2)).toBe(10.5);
  });

  it('converts zoom levels and percentages', () => {
    expect(levelScale(1, 2)).toBe(0.5);
    expect(levelScale(1, 0)).toBe(100);
    expect(zoomPercent(0.5, 2)).toBe(100);
  });

  it('limits the scale between Fit and the maximum zoom', () => {
    expect(scaleLimits(context)).toEqual({ min: 0.25, max: 4 });
    expect(scaleLimits({ ...context, dpr: 0 })).toEqual({ min: 0.25, max: 800 });
  });
});

describe('coordinate conversion', () => {
  it('finds the Fit centre', () => {
    expect(fitCentre(base, image)).toEqual({ x: 500, y: 400 });
  });

  it('converts between picture and screen pixels', () => {
    expect(imageToScreen(layout, { x: 100, y: 200 })).toEqual({ x: 62, y: 93 });
    expect(screenToImage(layout, { x: 100, y: 200 })).toEqual({ x: 176, y: 414 });
  });

  it('converts a screen point to 0..1 picture coordinates', () => {
    expect(screenToUnit(layout, image, { x: 1012, y: 743 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it('tells whether a screen point is on the picture, edges included', () => {
    expect(overPicture(layout, image, { x: 12, y: -7 })).toBe(true);
    expect(overPicture(layout, image, { x: 2012, y: 1493 })).toBe(true);
    expect(overPicture(layout, image, { x: 2013, y: 0 })).toBe(false);
    expect(overPicture(layout, image, { x: 11, y: 0 })).toBe(false);
  });
});

describe('clampPan', () => {
  it('lets a large picture go until the margin shows', () => {
    expect(clampPan({ x: 5000, y: -5000 }, 1, base, image, viewport)).toEqual({
      x: 1564,
      y: -1164,
    });
  });

  it('keeps a small picture where Fit puts it', () => {
    expect(clampPan({ x: 50, y: 50 }, 0.1, base, image, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('clamps each axis on its own', () => {
    expect(clampPan({ x: 300, y: 300 }, 0.3, base, image, viewport)).toEqual({ x: 164, y: 114 });
  });
});

describe('zoom and pan', () => {
  const zoomed = { scale: 1, pan: { x: 40, y: -30 } };

  it('returns to Fit at or near the Fit scale', () => {
    expect(zoomTo(FIT_VIEW, context, { x: 500, y: 400 }, 0.2)).toEqual(FIT_VIEW);
    expect(zoomTo(FIT_VIEW, context, { x: 500, y: 400 }, 0.2504)).toEqual(FIT_VIEW);
  });

  it('zooms in and clamps to the maximum', () => {
    expect(zoomTo(FIT_VIEW, context, { x: 300, y: 200 }, 1)).toEqual({
      scale: 1,
      pan: { x: 600, y: 600 },
    });
    expect(zoomTo(FIT_VIEW, context, { x: 300, y: 200 }, 100)).toEqual({
      scale: 4,
      pan: { x: 3000, y: 3000 },
    });
  });

  it('keeps the anchor point still while zooming from a zoomed view', () => {
    expect(zoomTo(zoomed, context, { x: 700, y: 100 }, 2)).toEqual({
      scale: 2,
      pan: { x: -120, y: 240 },
    });
    expect(zoomBy(zoomed, context, { x: 700, y: 100 }, 1.25)).toEqual({
      scale: 1.25,
      pan: { x: 0, y: 37.5 },
    });
    expect(zoomBy(FIT_VIEW, context, { x: 700, y: 100 }, 1.25)).toEqual({
      scale: 0.3125,
      pan: { x: -50, y: 75 },
    });
  });

  it('does not pan at Fit and clamps the pan otherwise', () => {
    expect(panBy(FIT_VIEW, context, { x: 5, y: 5 })).toEqual(FIT_VIEW);
    expect(panBy(zoomed, context, { x: 15, y: -2000 })).toEqual({
      scale: 1,
      pan: { x: 55, y: -1164 },
    });
  });

  it('re-applies the limits', () => {
    expect(reclamp(FIT_VIEW, context)).toEqual(FIT_VIEW);
    expect(reclamp({ scale: 1, pan: { x: 9999, y: 9999 } }, context)).toEqual({
      scale: 1,
      pan: { x: 1564, y: 1164 },
    });
    expect(reclamp({ scale: 0.2, pan: { x: 1, y: 1 } }, context)).toEqual(FIT_VIEW);
  });
});

describe('wheel', () => {
  const event = { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false };

  it('converts line and page deltas to pixels', () => {
    expect([wheelPixels(5, 0), wheelPixels(5, 1), wheelPixels(5, 2)]).toEqual([5, 165, 500]);
  });

  it('zooms one step per mouse notch and smoothly below it', () => {
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0 })).toBeCloseTo(0.8, 12);
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(1.25, 12);
    expect(wheelZoomFactor({ deltaY: 50, deltaMode: 0 })).toBeCloseTo(0.8944271909999159, 12);
    expect(wheelZoomFactor({ deltaY: 49, deltaMode: 0 })).toBeCloseTo(0.6126263941844161, 12);
    expect(wheelZoomFactor({ deltaY: -500, deltaMode: 0 })).toBeCloseTo(1.3070494407390916, 12);
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 1 })).toBeCloseTo(0.8017871416145864, 12);
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 0 })).toBeCloseTo(0.9704455335485082, 12);
    expect(wheelZoomFactor({ deltaY: 0, deltaMode: 0 })).toBe(1);
  });

  it('pans against the wheel on both axes', () => {
    expect(wheelPanDelta({ ...event, deltaX: 4, deltaY: 6 })).toEqual({ x: -4, y: -6 });
    expect(wheelPanDelta({ ...event, deltaY: 6, deltaMode: 1 })).toEqual({ x: 0, y: -198 });
    expect(wheelPanDelta(event)).toEqual({ x: 0, y: 0 });
  });

  it('pans sideways with Shift, falling back to the vertical delta', () => {
    expect(wheelPanDelta({ ...event, deltaY: 6, shiftKey: true })).toEqual({ x: -6, y: 0 });
    expect(wheelPanDelta({ ...event, deltaX: 3, deltaY: 6, shiftKey: true })).toEqual({
      x: -3,
      y: 0,
    });
    expect(wheelPanDelta({ ...event, shiftKey: true })).toEqual({ x: 0, y: 0 });
  });
});
