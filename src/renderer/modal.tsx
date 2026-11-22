// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, type ReactNode } from 'react';

type KeyHandlers = Partial<Record<string, (event: KeyboardEvent) => void>>;

/**
 * Runs the handler for the pressed key while a dialog is open, and hides every key from the app's
 * shortcuts. Capture phase, so Delete, Ctrl+E, Z and arrows never reach them. Only propagation
 * stops, so buttons and radios still do their default action.
 */
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

/** The dimmed backdrop behind a dialog. With `onDismiss`, a press on the backdrop itself closes it. */
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
