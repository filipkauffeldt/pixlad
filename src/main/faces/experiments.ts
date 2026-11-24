// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Speedups under test. Off in the app; scripts/gpu-bench.ts turns them on per benchmark column.

export const experiments = {
  /** `dehaze` without a new array and six helper calls per pixel. */
  dehaze: false,
  /** YuNet input tensors from a pool instead of a new 5 MB array per run. */
  buffers: false,
};

export type Experiment = keyof typeof experiments;
