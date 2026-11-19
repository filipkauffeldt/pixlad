// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { availableParallelism } from 'node:os';
import * as ort from 'onnxruntime-node';

/** Where the face models are. YuNet finds faces; the others find heads and outline faces. */
export interface ModelPaths {
  yunet: string;
  deimS: string;
  deimN: string;
  segmenter: string;
}

/** The models behind Outlines. YuNet has its own sessions. */
export type OutlineModel = Exclude<keyof ModelPaths, 'yunet'>;

const sessions = new Map<string, Promise<ort.InferenceSession>>();

// Measured faster than all cores for these models, and leaves room for the JavaScript work that
// overlaps the next run.
const THREADS = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

/** The session of an outline model, created on first use. */
export function loadModel(paths: ModelPaths, model: OutlineModel): Promise<ort.InferenceSession> {
  const path = paths[model];
  let session = sessions.get(path);
  if (!session) {
    session = ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: THREADS,
      // No memory pool: the pool grows to the largest run so far and keeps it (about 500 MB more
      // after a big detection). Without it memory follows the current run, at no measured cost.
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    sessions.set(path, session);
    session.catch(() => sessions.delete(path));
  }
  return session;
}
