// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { ReactNode } from 'react';

/** Line icons on a 24px grid, drawn in the colour of the text around them. */
const ICONS = {
  cog: (
    <>
      <path d="M18.6 9.98 21.44 10.25 21.44 13.75 18.6 14.02 18.09 15.24 19.91 17.44 17.44 19.91 15.24 18.09 14.02 18.6 13.75 21.44 10.25 21.44 9.98 18.6 8.76 18.09 6.56 19.91 4.09 17.44 5.91 15.24 5.4 14.02 2.56 13.75 2.56 10.25 5.4 9.98 5.91 8.76 4.09 6.56 6.56 4.09 8.76 5.91 9.98 5.4 10.25 2.56 13.75 2.56 14.02 5.4 15.24 5.91 17.44 4.09 19.91 6.56 18.09 8.76Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  rect: <rect x="4" y="5.5" width="16" height="13" />,
  lasso: (
    <>
      <path d="M7 18c-2-1-3-3-3-6 0-4 4-7 8-7s8 2.5 8 6-4 5-8 5c-1.5 0-3-.3-4-.8" />
      <circle cx="7" cy="18.5" r="1.6" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  find: (
    <>
      <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
      <path d="M12 8.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" />
    </>
  ),
  chevron: <path d="M8 10l4 4 4-4" />,
  undo: (
    <>
      <path d="M8.5 5 4.5 9l4 4" />
      <path d="M4.5 9h10a4.5 4.5 0 0 1 0 9H10" />
    </>
  ),
  redo: (
    <>
      <path d="M15.5 5l4 4-4 4" />
      <path d="M19.5 9h-10a4.5 4.5 0 0 0 0 9H14" />
    </>
  ),
  clear: (
    <>
      <path d="M5 15.5 13.5 7l5 5L12 18.5H8z" />
      <path d="M9.5 11l5 5M12 18.5h8" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
