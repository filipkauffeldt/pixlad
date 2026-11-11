import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rect } from '../src/shared/types';
import { actions, getState } from '../src/renderer/store';

const region: Rect = { type: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  actions.setDetecting(false);
  actions.noFacesFound();
  vi.runAllTimers();
  for (const n of getState().notices) actions.dismissNotice(n.id);
  vi.useRealTimers();
});

describe('detection feedback', () => {
  it('keeps the region being searched until the detector stops', () => {
    actions.setDetecting(true, region);
    expect(getState().detecting).toBe(true);
    expect(getState().detectRegion?.shape).toEqual(region);
    actions.setDetecting(false);
    expect(getState().detecting).toBe(false);
    expect(getState().detectRegion).toBeUndefined();
  });

  it('has no shape when the whole photo is searched', () => {
    actions.setDetecting(true);
    expect(getState().detectRegion).toEqual({ photoId: undefined, shape: undefined });
  });

  it('says "no faces" at the region for two seconds, and not as a notice', () => {
    actions.setDetecting(true, region);
    actions.noFacesFound();
    actions.setDetecting(false); // the detector's finally
    expect(getState().detecting).toBe(false);
    expect(getState().noFaces?.shape).toEqual(region);
    expect(getState().notices).toHaveLength(0);
    vi.advanceTimersByTime(1999);
    expect(getState().noFaces).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(getState().noFaces).toBeUndefined();
  });

  it('drops an earlier "no faces" when the next search starts', () => {
    actions.setDetecting(true, region);
    actions.noFacesFound();
    actions.setDetecting(true, region);
    expect(getState().noFaces).toBeUndefined();
    vi.advanceTimersByTime(5000);
    expect(getState().detectRegion).toBeDefined();
  });
});
