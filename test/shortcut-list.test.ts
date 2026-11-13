import { describe, expect, it } from 'vitest';
import { shortcutList } from '../src/renderer/shortcut-list';

describe('the shortcuts list', () => {
  it('names only the modifier of the platform it is built for', () => {
    const keys = (mod: string): string[] => shortcutList(mod).flatMap((s) => [...s.keys]);
    expect(keys('Ctrl')).toContain('Ctrl');
    expect(keys('Ctrl')).not.toContain('⌘');
    expect(keys('⌘')).toContain('⌘');
    expect(keys('⌘')).not.toContain('Ctrl');
  });

  it('lists Ctrl+Y for redo on Windows and Linux only', () => {
    const redo = (mod: string): string[] =>
      shortcutList(mod)
        .filter((s) => s.does === 'Redo')
        .map((s) => s.keys.join('+'));
    expect(redo('Ctrl')).toEqual(['Ctrl+Shift+Z', 'Ctrl+Y']);
    expect(redo('⌘')).toEqual(['⌘+Shift+Z']);
  });

  it('lists the shortcuts of this window, each with keys and a description', () => {
    const list = shortcutList('Ctrl');
    for (const s of list) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.does).not.toBe('');
    }
    const has = (...keys: string[]): boolean =>
      list.some((s) => s.keys.join('+') === keys.join('+'));
    expect(has('Ctrl', 'Z')).toBe(true);
    expect(has('Ctrl', 'E')).toBe(true);
    expect(has('Ctrl', 'Shift', 'Z')).toBe(true);
    expect(has('Ctrl', 'O')).toBe(true);
    expect(has('F')).toBe(true);
    expect(has('B')).toBe(true);
    expect(has('?')).toBe(true);
    expect(has('Space')).toBe(true);
    expect(has('Right-click')).toBe(true);
    expect(has('Delete / Backspace')).toBe(true);
  });
});
