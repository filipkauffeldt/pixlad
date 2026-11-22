// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, type ReactNode } from 'react';

type KeyHandlers = Partial<Record<string, (event: KeyboardEvent) => void>>;

/** Capture phase, so app shortcuts never fire under a dialog; default actions still run. */
export function useModalKeys(handlers: KeyHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      latest.current[event.key]?.(event);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

export function Scrim({ onDismiss, children }: { onDismiss?: () => void; children: ReactNode }) {
  return (
    <div
      className="modalScrim"
      onPointerDown={
        onDismiss &&
        ((event) => {
          if (event.target === event.currentTarget) onDismiss();
        })
      }
    >
      {children}
    </div>
  );
}
