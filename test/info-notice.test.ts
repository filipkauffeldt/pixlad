import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, getState } from '../src/renderer/store';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const n of getState().notices) actions.dismissNotice(n.id);
  vi.useRealTimers();
});

describe('info notices', () => {
  it('shows only the latest one', () => {
    actions.notice(['No faces found in that area.']);
    actions.notice(['No faces found in that area.']);
    expect(getState().notices).toHaveLength(1);
  });

  it('clears itself after 8 seconds', () => {
    actions.notice(['No faces found in that area.']);
    vi.advanceTimersByTime(7999);
    expect(getState().notices).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getState().notices).toHaveLength(0);
  });

  it('restarts the countdown when a new one replaces it', () => {
    actions.notice(['first']);
    vi.advanceTimersByTime(5000);
    actions.notice(['second']);
    vi.advanceTimersByTime(5000);
    expect(getState().notices.map((n) => n.lines[0])).toEqual(['second']);
    vi.advanceTimersByTime(3000);
    expect(getState().notices).toHaveLength(0);
  });

  it('leaves errors until they are dismissed', () => {
    actions.notice(['Could not save'], 'error');
    actions.notice(['No faces found in that area.']);
    vi.advanceTimersByTime(60_000);
    expect(getState().notices.map((n) => n.kind)).toEqual(['error']);
  });
});
