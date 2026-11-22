// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt

export interface ReleaseNote {
  title: string;
  pr?: number;
}

export type UpdateCheck =
  | { status: 'up-to-date' }
  | { status: 'available'; version: string; notes?: ReleaseNote[] }
  | { status: 'error'; message: string };

export type UpdateDownload =
  | { ok: true; next: 'restart' }
  | { ok: true; next: 'opened'; fileName: string }
  | { ok: false; message: string };

export const RELEASES_OWNER = 'filipkauffeldt';
export const RELEASES_REPO = 'pixlad';

export function parseReleaseNotes(body: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^#+\s+New Contributors/i.test(line)) break;
    const bullet = /^\s*[*-]\s+(.+?)\s*$/.exec(line);
    if (!bullet) continue;
    let title = bullet[1]!;
    const link = /\s+in\s+(?:\S*\/pull\/|#)(\d+)$/.exec(title);
    if (link) title = title.slice(0, link.index);
    title = title.replace(/\s+by\s+@\S+$/, '');
    notes.push(link ? { title, pr: Number(link[1]) } : { title });
  }
  return notes;
}
