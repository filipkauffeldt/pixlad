// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
//
// The `parallel` speedup for gpu-bench: worker threads that each hold their own copy of a model,
// so several inputs run at once.
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';
import type { RunMany } from '../src/main/faces/experiments';
import type { ModelJob, ModelReply } from './gpu-bench-model-worker';

export interface ModelPool {
  runMany: RunMany;
  close(): Promise<void>;
}

/**
 * `copies` worker threads. `onBatch` hears how many runs of which model took how long, from the
 * first input sent to the last result back.
 */
export function modelPool(
  copies: number,
  scriptsDir: string,
  onBatch: (path: string, runs: number, ms: number) => void,
): ModelPool {
  const workers = Array.from(
    { length: copies },
    () => new Worker(join(scriptsDir, 'gpu-bench-model-worker.ts')),
  );
  const idle = [...workers];
  const queue: Array<() => void> = [];
  const pending = new Map<number, (reply: ModelReply) => void>();
  let nextId = 1;
  for (const worker of workers) {
    worker.on('message', (reply: ModelReply) => {
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    });
  }

  async function runOne(job: Omit<ModelJob, 'id'>): Promise<ort.InferenceSession.OnnxValueMapType> {
    while (idle.length === 0) await new Promise<void>((resolve) => queue.push(resolve));
    const worker = idle.pop()!;
    const id = nextId++;
    try {
      const reply = await new Promise<ModelReply>((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ ...job, id } satisfies ModelJob);
      });
      if (!reply.outputs) throw new Error(reply.error ?? 'the model worker failed');
      return Object.fromEntries(
        Object.entries(reply.outputs).map(([name, t]) => [
          name,
          new ort.Tensor(t.type, t.data as Float32Array, t.dims),
        ]),
      );
    } finally {
      idle.push(worker);
      queue.shift()?.();
    }
  }

  return {
    runMany: async (path, options, feeds) => {
      const start = performance.now();
      const outputs = await Promise.all(
        feeds.map((f) =>
          runOne({
            path,
            options,
            feeds: Object.fromEntries(
              Object.entries(f).map(([name, t]) => [
                name,
                { type: t.type, data: t.data, dims: t.dims },
              ]),
            ),
          }),
        ),
      );
      onBatch(path, feeds.length, performance.now() - start);
      return outputs;
    },
    close: async () => {
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}
