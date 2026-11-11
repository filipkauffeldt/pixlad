// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { isMac } from './flips';

/** One line of the shortcuts sheet: the keys (joined by "+") and what they do. */
export interface Shortcut {
  keys: readonly string[];
  does: string;
}

/** Every shortcut the sheet lists, in the order it shows them. Add a line here to list a new one. */
export const shortcutList = (mod: string): Shortcut[] => [
  { keys: ['Drag'], does: 'Find faces in a region, or draw an area, depending on the target' },
  { keys: ['Click'], does: 'Switch the area under the pointer on or off' },
  { keys: ['Alt'], does: 'Hold to draw with the other outline (rectangle or lasso)' },
  { keys: [mod], does: 'Hold to flip Add and Subtract' },
  { keys: [mod, 'Z'], does: 'Undo' },
  { keys: ['← / →'], does: 'Previous / next photo' },
  { keys: ['Delete'], does: 'Remove the photo from the session' },
  { keys: [mod, 'E'], does: 'Export the photo' },
  { keys: ['Z'], does: 'Toggle Fit and 100%' },
  { keys: [mod, '+'], does: 'Zoom in' },
  { keys: [mod, '−'], does: 'Zoom out' },
  { keys: [mod, '0'], does: 'Fit the photo' },
  { keys: [mod, 'Wheel'], does: 'Zoom at the pointer (also a pinch on a trackpad)' },
  { keys: ['Wheel'], does: 'Pan a zoomed photo' },
  { keys: ['Space'], does: 'Hold and drag to pan' },
  { keys: ['B'], does: 'Hold to see the photo without the mosaic and outlines' },
  { keys: ['?'], does: 'Show these shortcuts' },
];

/** The list for this machine: only its own modifier, Ctrl or ⌘. */
export const SHORTCUTS = shortcutList(isMac ? '⌘' : 'Ctrl');
