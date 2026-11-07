// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { Notice } from '../shared/ipc';

/** Exactly the generator's rule: licence texts have shorter or longer `=` lines of their own. */
const RULE = /^={79}$/;

/**
 * The sections of THIRD_PARTY_NOTICES.txt, as scripts/third-party-notices.ts writes them: a rule,
 * the title line (and a homepage for npm packages), a rule, then the text up to the next rule.
 */
export function parseNotices(text: string): Notice[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const notices: Notice[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!RULE.test(lines[i]!)) continue;
    const close = lines.findIndex((line, j) => j > i && RULE.test(line));
    if (close < 0) break;
    const [title = '', homepage] = lines.slice(i + 1, close);
    let end = lines.findIndex((line, j) => j > close && RULE.test(line));
    if (end < 0) end = lines.length;
    notices.push({
      title,
      ...(homepage ? { homepage } : {}),
      text: lines
        .slice(close + 1, end)
        .join('\n')
        .trim(),
    });
    i = end - 1;
  }
  return notices;
}
