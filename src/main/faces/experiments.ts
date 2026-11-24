// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Speedups under test. Off in the app; scripts/gpu-bench.ts turns them on per benchmark column.
import type { InferenceSession, Tensor } from 'onnxruntime-node';

export const experiments = {
  /** `dehaze` without a new array and six helper calls per pixel. */
  dehaze: false,
  /** YuNet input tensors from a pool instead of a new 5 MB array per run. */
  buffers: false,
};

export type Experiment = keyof typeof experiments;

type Feeds = Record<string, Tensor>;

/** Runs `feeds` through the model at `path`, several at once in other threads. */
export type RunMany = (
  path: string,
  options: InferenceSession.SessionOptions,
  feeds: Feeds[],
) => Promise<InferenceSession.OnnxValueMapType[]>;

/** Set by the benchmark to try running model inputs in parallel. */
export const parallel: { runMany?: RunMany } = {};

/** How many inputs to prepare before running them: one at a time, unless they can run in parallel. */
export const batchSize = (): number => (parallel.runMany ? 8 : 1);

/** Each of `feeds` through `session`, or through `parallel.runMany` when it is set. */
export async function runAll(
  session: InferenceSession,
  path: string,
  options: InferenceSession.SessionOptions,
  feeds: Feeds[],
): Promise<InferenceSession.OnnxValueMapType[]> {
  if (parallel.runMany && feeds.length > 1) return parallel.runMany(path, options, feeds);
  const out: InferenceSession.OnnxValueMapType[] = [];
  for (const f of feeds) out.push(await session.run(f));
  return out;
}
