import { describe, expect, it } from 'vitest';
import { isWindowState, onScreen } from '../src/main/window-state';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };
const state = { x: 100, y: 80, width: 1200, height: 800, maximized: false };

describe('the saved window', () => {
  it('accepts a complete state and refuses a damaged one', () => {
    expect(isWindowState(state)).toBe(true);
    for (const bad of [null, 'x', { ...state, width: 0 }, { ...state, x: 'a' }, { x: 1 }]) {
      expect(isWindowState(bad)).toBe(false);
    }
  });

  it('is used while it is still on a screen', () => {
    expect(onScreen(state, [screen])).toEqual(state);
  });

  it('is dropped when its monitor is gone', () => {
    const elsewhere = { ...state, x: 2500 };
    expect(onScreen(elsewhere, [screen])).toBeUndefined();
    expect(onScreen(elsewhere, [screen, { x: 1920, y: 0, width: 1920, height: 1080 }])).toEqual(
      elsewhere,
    );
  });

  it('is dropped when only a sliver would show', () => {
    expect(onScreen({ ...state, x: 1850 }, [screen])).toBeUndefined();
  });

  it('gives undefined when nothing was saved', () => {
    expect(onScreen(undefined, [screen])).toBeUndefined();
  });
});
