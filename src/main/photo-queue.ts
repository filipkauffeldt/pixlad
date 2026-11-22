// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt

export class PhotoQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private wantedId: string | undefined;
  private openId: string | undefined;

  constructor(
    private readonly lookup: (id: string) => { path: string } | undefined,
    private readonly openInWorker: (path: string) => Promise<unknown>,
  ) {}

  forgetOpen(id: string): void {
    if (this.openId === id) this.openId = undefined;
  }

  run<T>(id: string, job: () => Promise<T>): Promise<T> {
    this.wantedId = id;
    const next = this.chain.then(async () => {
      const photo = this.lookup(id);
      if (!photo) throw new Error('that photo is no longer in the session');
      if (this.openId !== id) {
        if (this.wantedId !== id) throw new Error('another photo was opened meanwhile');
        this.openId = undefined;
        await this.openInWorker(photo.path);
        this.openId = id;
      }
      return job();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
