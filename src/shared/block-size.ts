// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { MIN_BLOCK_SIZE } from './mosaic';

const LONG_EDGE_PER_DEFAULT_BLOCK = 100;

export const BLOCK_SIZE_PX = { min: MIN_BLOCK_SIZE, max: 256, step: 1 } as const;

export const blockSizePxToRel = (px: number, longEdge: number): number =>
  Math.max(1, Math.round(px)) / longEdge;

export const blockSizeRelToPx = (rel: number, longEdge: number): number =>
  Math.max(1, Math.round(rel * longEdge));

export const defaultBlockPx = (longEdge: number): number =>
  Math.min(
    BLOCK_SIZE_PX.max,
    Math.max(MIN_BLOCK_SIZE, Math.round(longEdge / LONG_EDGE_PER_DEFAULT_BLOCK)),
  );
