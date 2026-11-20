// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { isMac } from './flips';

/** One line of the shortcuts sheet: the keys (joined by "+") and what they do. */
export interface Shortcut {
  keys: readonly string[];
  does: string;
  /** The column it is listed in: editing the photo, or moving between and around photos. */
  group: 'edit' | 'view';
}

/** Every shortcut the sheet lists, in the order it shows them. Add a line here to list a new one. */
export const shortcutList = (mod: string): Shortcut[] => [
  {
    keys: ['Drag'],
    does: 'Find faces in a region, or draw an area, depending on the target',
    group: 'edit',
  },
  { keys: ['F'], does: 'Find all the faces in the photo', group: 'edit' },
  { keys: ['Click'], does: 'Switch the area under the pointer on or off', group: 'edit' },
  { keys: ['Right-click'], does: 'Remove the area under the pointer', group: 'edit' },
  { keys: ['Delete / Backspace'], does: 'Remove the area under the pointer', group: 'edit' },
  {
    keys: ['Alt'],
    does: 'Hold to draw with the other outline (rectangle or lasso)',
    group: 'edit',
  },
  { keys: [mod], does: 'Hold to flip Add and Subtract', group: 'edit' },
  { keys: [mod, 'Z'], does: 'Undo', group: 'edit' },
  { keys: [mod, 'Shift', 'Z'], does: 'Redo', group: 'edit' },
  // Windows and Linux also take the other common key for redo.
  ...(mod === '⌘' ? [] : [{ keys: [mod, 'Y'], does: 'Redo', group: 'edit' } satisfies Shortcut]),
  { keys: ['← / →'], does: 'Previous / next photo', group: 'view' },
  {
    keys: ['Delete'],
    does: 'Remove the photo from the session, when not over an area (asks first if it has unexported areas)',
    group: 'view',
  },
  { keys: [mod, 'O'], does: 'Add photos to the session', group: 'view' },
  { keys: [mod, 'E'], does: 'Export the photo', group: 'view' },
  { keys: ['Z'], does: 'Toggle Fit and 100%', group: 'view' },
  { keys: [mod, '+'], does: 'Zoom in', group: 'view' },
  { keys: [mod, '−'], does: 'Zoom out', group: 'view' },
  { keys: [mod, '0'], does: 'Fit the photo', group: 'view' },
  { keys: [mod, 'Wheel'], does: 'Zoom at the pointer (also a pinch on a trackpad)', group: 'view' },
  { keys: ['Wheel'], does: 'Pan a zoomed photo', group: 'view' },
  { keys: ['Space'], does: 'Hold and drag to pan', group: 'view' },
  { keys: ['B'], does: 'Hold to see the photo without the mosaic and outlines', group: 'view' },
  { keys: ['?'], does: 'Show these shortcuts', group: 'view' },
];

/** The list for this machine: only its own modifier, Ctrl or ⌘. */
export const SHORTCUTS = shortcutList(isMac ? '⌘' : 'Ctrl');
