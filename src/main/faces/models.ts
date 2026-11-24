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

export const OUTLINE_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
  intraOpNumThreads: THREADS,
  // No memory pool: the pool grows to the largest run so far and keeps it. Without it,
  // memory follows the current run, and the speed is the same.
  enableCpuMemArena: false,
  enableMemPattern: false,
};

export const outlinePath = (modelsDir: string, model: OutlineModel): string =>
  join(modelsDir, OUTLINE_MODELS[model]);

const sessions = new Map<OutlineModel, Promise<ort.InferenceSession>>();

/** The session for one of the outline models in `modelsDir`, loaded on first use. */
export function outlineModel(
  modelsDir: string,
  model: OutlineModel,
): Promise<ort.InferenceSession> {
  let session = sessions.get(model);
  if (!session) {
    const path = outlinePath(modelsDir, model);
    if (!existsSync(path)) {
      throw new Error(
        `The face model ${OUTLINE_MODELS[model]} is missing. Run "pnpm fetch-model".`,
      );
    }
    session = ort.InferenceSession.create(path, OUTLINE_OPTIONS);
    sessions.set(model, session);
    session.catch(() => sessions.delete(model));
  }
  return session;
}

/** The models are freed this long after the last job that used them. */
const IDLE_MS = 90_000;
let busy = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** Run `job` with the outline models kept loaded; once nothing has used them for a while, free them. */
export async function withOutlineModels<T>(job: () => Promise<T>): Promise<T> {
  busy++;
  clearTimeout(idleTimer);
  try {
    return await job();
  } finally {
    busy--;
    if (busy === 0) idleTimer = setTimeout(releaseOutlineModels, IDLE_MS);
  }
}

/** Load the outline models ahead of use, so the first Outlines detection doesn't wait for them. */
export const warmOutlineModels = (modelsDir: string): Promise<void> =>
  withOutlineModels(async () => {
    await Promise.all(
      (Object.keys(OUTLINE_MODELS) as OutlineModel[]).map((m) => outlineModel(modelsDir, m)),
    );
  });

function releaseOutlineModels(): void {
  if (busy > 0) return;
  const loaded = [...sessions.values()];
  sessions.clear();
  for (const session of loaded) {
    void session.then((s) => s.release()).catch(() => undefined);
  }
}
