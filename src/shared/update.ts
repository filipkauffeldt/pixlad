// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt

/** One line of a release's change list. */
export interface ReleaseNote {
  title: string;
  pr?: number;
}

/** The answer to "is there a newer release". */
export type UpdateCheck =
  | { status: 'up-to-date' }
  | { status: 'available'; version: string; notes?: ReleaseNote[] }
  | { status: 'error'; message: string };

/** What a finished download leaves the user to do. */
export type UpdateDownload =
  | { ok: true; next: 'restart' }
  | { ok: true; next: 'opened'; fileName: string }
  | { ok: false; message: string };

/** The GitHub repository the releases come from. */
export const RELEASES_OWNER = 'filipkauffeldt';
export const RELEASES_REPO = 'pixlad';

/** The bullets of a GitHub release body, without the author and the link to the pull request. */
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
