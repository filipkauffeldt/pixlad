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
