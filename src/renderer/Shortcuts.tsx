// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { SHORTCUTS } from './shortcut-list';
import { actions } from './store';

/** Every keyboard shortcut, one list. Opened with ? or from Settings. */
const GROUPS = [
  { group: 'edit', title: 'Edit' },
  { group: 'view', title: 'Photos and view' },
] as const;

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
            className="iconBtn close"
            aria-label="Close"
            onClick={() => actions.setShortcutsOpen(false)}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modalBody shortcutColumns">
          {GROUPS.map(({ group, title }) => (
            <section key={group}>
              <h3 className="label">{title}</h3>
              <dl className="shortcutList">
                {SHORTCUTS.filter((s) => s.group === group).map(({ keys, does }) => (
                  <div
                    className="shortcutRow"
                    key={`${keys.join('+')} ${does}`}
                    data-testid="shortcut"
                  >
                    <dd>{does}</dd>
                    <dt>
                      {keys.map((key) => (
                        <kbd className="mono" key={key}>
                          {key}
                        </kbd>
                      ))}
                    </dt>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
