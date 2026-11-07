// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { MIN_BLOCK_SIZE } from './mosaic';

/** The toolbar shows the block in pixels of the full-resolution photo; the op stores a fraction. */
export const BLOCK_SIZE_PX = { min: MIN_BLOCK_SIZE, max: 256, step: 1 } as const;

export const blockSizePxToRel = (px: number, longEdge: number): number =>
  Math.max(1, Math.round(px)) / longEdge;

export const blockSizeRelToPx = (rel: number, longEdge: number): number =>
  Math.max(1, Math.round(rel * longEdge));

/** The block a new photo starts with: about 1% of the long edge, never below the floor. */
export const defaultBlockPx = (longEdge: number): number =>
  Math.min(BLOCK_SIZE_PX.max, Math.max(MIN_BLOCK_SIZE, Math.round(longEdge / 100)));
