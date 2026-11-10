import { describe, expect, it } from 'vitest';
import { flipsHeld, withFlips } from '../src/renderer/retouch';

const keys = { altKey: false, ctrlKey: false, metaKey: false };

describe('flipsHeld', () => {
  it('reads Alt as the outline flip and Ctrl as the mode flip', () => {
    expect(flipsHeld({ ...keys, altKey: true }, false)).toEqual({ outline: true, mode: false });
    expect(flipsHeld({ ...keys, ctrlKey: true }, false)).toEqual({ outline: false, mode: true });
    expect(flipsHeld({ ...keys, altKey: true, ctrlKey: true }, false)).toEqual({
      outline: true,
      mode: true,
    });
  });

  it('uses Command, not Control, for the mode flip on a Mac', () => {
    expect(flipsHeld({ ...keys, metaKey: true }, true).mode).toBe(true);
    expect(flipsHeld({ ...keys, ctrlKey: true }, true).mode).toBe(false);
  });

  it('ignores AltGr, which types characters', () => {
    const altGr = { altKey: true, ctrlKey: true, metaKey: false, getModifierState: () => true };
    expect(flipsHeld(altGr, false)).toEqual({ outline: false, mode: false });
  });
});

describe('withFlips', () => {
  it('leaves the choice alone when nothing is held', () => {
    const chosen = { outline: 'rect', mode: 'add' } as const;
    expect(withFlips(chosen, { outline: false, mode: false })).toEqual(chosen);
  });

  it('swaps each side on its own', () => {
    const chosen = { outline: 'rect', mode: 'add' } as const;
    expect(withFlips(chosen, { outline: true, mode: false })).toEqual({
      outline: 'lasso',
      mode: 'add',
    });
    expect(withFlips(chosen, { outline: false, mode: true })).toEqual({
      outline: 'rect',
      mode: 'subtract',
    });
    expect(
      withFlips({ outline: 'lasso', mode: 'subtract' }, { outline: true, mode: true }),
    ).toEqual({ outline: 'rect', mode: 'add' });
  });
});
