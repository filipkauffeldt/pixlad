// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
//
// A worker thread for the `parallel` speedup in gpu-bench: runs model inputs it is sent through its
// own copy of the model. A run blocks its thread, so parallel runs need a thread each.
import { parentPort } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';

interface Plain {
  type: ort.Tensor.Type;
  data: ort.Tensor.DataType;
  dims: readonly number[];
}

export interface ModelJob {
  id: number;
  path: string;
  options: ort.InferenceSession.SessionOptions;
  feeds: Record<string, Plain>;
}

export interface ModelReply {
  id: number;
  outputs?: Record<string, Plain>;
  error?: string;
}

const sessions = new Map<string, Promise<ort.InferenceSession>>();

async function run(job: ModelJob): Promise<Record<string, Plain>> {
  let session = sessions.get(job.path);
  if (!session) {
    session = ort.InferenceSession.create(job.path, job.options);
    sessions.set(job.path, session);
  }
  const feeds = Object.fromEntries(
    Object.entries(job.feeds).map(([name, t]) => [
      name,
      new ort.Tensor(t.type, t.data as Float32Array, t.dims),
    ]),
  );
  const outputs = await (await session).run(feeds);
  return Object.fromEntries(
    Object.entries(outputs).map(([name, t]) => [
      name,
      { type: t.type, data: t.data, dims: t.dims },
    ]),
  );
}

parentPort!.on('message', (job: ModelJob) => {
  run(job).then(
    (outputs) => parentPort!.postMessage({ id: job.id, outputs } satisfies ModelReply),
    (cause: unknown) =>
      parentPort!.postMessage({ id: job.id, error: String(cause) } satisfies ModelReply),
  );
});
