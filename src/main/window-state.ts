// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { WindowState } from '../shared/ipc';

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isWindowState(value: unknown): value is WindowState {
  const state = value as Partial<WindowState> | null;
  return (
    typeof state === 'object' &&
    state !== null &&
    [state.x, state.y, state.width, state.height].every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    ) &&
    state.width! > 0 &&
    state.height! > 0 &&
    typeof state.maximized === 'boolean'
  );
}

/**
 * The saved state, when enough of it is still on a screen. A window saved on a monitor that is
 * gone would open out of reach, so then the caller falls back to the default.
 */
export function onScreen(
  state: WindowState | undefined,
  workAreas: readonly Area[],
): WindowState | undefined {
  if (!state) return undefined;
  const visible = workAreas.some((area) => {
    const width = Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x);
    const height =
      Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y);
    return width >= 100 && height >= 100;
  });
  return visible ? state : undefined;
}
