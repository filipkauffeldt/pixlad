// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useState } from 'react';
import { flipsHeld, type Flips } from './retouch';

export const isMac = navigator.platform.toLowerCase().includes('mac');

const NONE: Flips = { outline: false, mode: false };

/** The flips held right now, so the toolbar can show what a drag would do. */
export function useFlips(): Flips {
  const [flips, setFlips] = useState(NONE);
  useEffect(() => {
    const update = (event: KeyboardEvent): void => {
      const next = flipsHeld(event, isMac);
      setFlips((now) => (now.outline === next.outline && now.mode === next.mode ? now : next));
    };
    const clear = (): void => setFlips(NONE);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return flips;
}
