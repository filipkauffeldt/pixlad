// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt

/** The answer to "is there a newer release". */
export type UpdateCheck =
  | { status: 'up-to-date' }
  | { status: 'available'; version: string }
  | { status: 'error'; message: string };

/** What a finished download leaves the user to do. */
export type UpdateDownload =
  | { ok: true; next: 'restart' }
  | { ok: true; next: 'opened'; fileName: string }
  | { ok: false; message: string };

/** The GitHub repository the releases come from. */
export const RELEASES_OWNER = 'filipkauffeldt';
export const RELEASES_REPO = 'pixlad';
