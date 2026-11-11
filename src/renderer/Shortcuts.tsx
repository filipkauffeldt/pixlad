// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef } from 'react';
import { SHORTCUTS } from './shortcut-list';
import { actions } from './store';

/** Every keyboard shortcut, one list. Opened with ? or from Settings. */
export function Shortcuts() {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    // Capture phase on the window, as in About: the app's shortcuts never see a key while the
    // sheet is open. Buttons still activate, because that is the default action.
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') actions.setShortcutsOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div
      className="modalScrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) actions.setShortcutsOpen(false);
      }}
    >
      <div
        className="modal shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        data-testid="shortcuts"
      >
        <header className="modalHeader">
          <div className="aboutTitle">
            <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          </div>
          <button
            ref={close}
            type="button"
            className="close"
            aria-label="Close"
            onClick={() => actions.setShortcutsOpen(false)}
          >
            ×
          </button>
        </header>
        <div className="modalBody">
          <dl className="shortcutList">
            {SHORTCUTS.map(({ keys, does }) => (
              <div className="shortcutRow" key={`${keys.join('+')} ${does}`} data-testid="shortcut">
                <dt>
                  {keys.map((key, i) => (
                    <span key={key}>
                      {i > 0 && <span className="plus">+</span>}
                      <kbd className="mono">{key}</kbd>
                    </span>
                  ))}
                </dt>
                <dd>{does}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
