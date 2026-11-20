// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// The models behind the Outlines face shape, next to the YuNet model in the models folder.
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';

export const OUTLINE_MODELS = {
  heads: 'deimv2-s-wholebody34.onnx',
  smallHeads: 'deimv2-n-wholebody34.onnx',
  segmenter: 'selfie-multiclass.onnx',
} as const;
export type OutlineModel = keyof typeof OUTLINE_MODELS;

/** Measured faster than the default (all cores) for these models. */
const THREADS = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

const sessions = new Map<OutlineModel, Promise<ort.InferenceSession>>();

/** The session for one of the outline models in `modelsDir`, loaded on first use. */
export function outlineModel(
  modelsDir: string,
  model: OutlineModel,
): Promise<ort.InferenceSession> {
  let session = sessions.get(model);
  if (!session) {
    const path = join(modelsDir, OUTLINE_MODELS[model]);
    if (!existsSync(path)) {
      throw new Error(
        `The face model ${OUTLINE_MODELS[model]} is missing. Run "pnpm fetch-model".`,
      );
    }
    session = ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: THREADS,
      // No memory pool: the pool grows to the largest run so far and keeps it. Without it,
      // memory follows the current run, and the speed is the same.
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    sessions.set(model, session);
    session.catch(() => sessions.delete(model));
  }
  return session;
}
