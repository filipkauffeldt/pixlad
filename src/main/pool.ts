// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { Worker } from 'node:worker_threads';
import type { WorkerReply, WorkerRequest } from './worker';

type Distribute<T> = T extends { id: number } ? Omit<T, 'id'> : never;
export type Task = Distribute<WorkerRequest>;

/** A worker thread that answers one request at a time, in order. */
export class WorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();

  constructor(file: URL, modelPath: string) {
    this.worker = new Worker(file, { workerData: { modelPath } });
    this.worker.on('message', (reply: WorkerReply) => {
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.value);
      else entry.reject(Object.assign(new Error(reply.message), { failure: reply.failure }));
    });
    const fail = (error: Error): void => {
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => fail(new Error(`the image worker stopped (${code})`)));
  }

  run<T>(task: Task): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...task, id } as WorkerRequest);
    });
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

/** Runs async jobs with a fixed concurrency; used for thumbnails. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
