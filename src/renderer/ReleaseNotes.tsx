// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { Icon } from './Icon';
import { Scrim, useModalKeys } from './modal';
import { actions, useApp } from './store';

/** What changed in the update that was found. */
export function ReleaseNotes() {
  const app = useApp();
  const update = app.update;
  const version = update.phase === 'idle' ? '' : update.version;

  useModalKeys({ Escape: () => actions.setNotesOpen(false) });

  const primary =
    update.phase === 'available'
      ? { label: 'Update', run: () => actions.startUpdate() }
      : update.phase === 'ready'
        ? { label: 'Restart to update', run: () => actions.installUpdate() }
        : undefined;

  return (
    <Scrim onDismiss={() => actions.setNotesOpen(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notes-title"
        data-testid="release-notes"
      >
        <header className="modalHeader">
          <div className="aboutTitle">
            <h2 id="notes-title">{`What's new in Pixlad ${version}`}</h2>
          </div>
          <button
            type="button"
            className="iconBtn close"
            aria-label="Close"
            autoFocus
            onClick={() => actions.setNotesOpen(false)}
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modalBody">
          <ul className="notices" data-testid="release-notes-list">
            {app.updateNotes?.map((note, i) => (
              <li className="changeRow" key={i}>
                <span>{note.title}</span>
                {note.pr !== undefined && <span className="mono muted">{`#${note.pr}`}</span>}
              </li>
            ))}
          </ul>
        </div>
        <footer className="modalFooter">
          <button
            type="button"
            className="inlineLink mono muted"
            onClick={() => void window.api.openReleaseNotes(version)}
            data-testid="release-notes-github"
          >
            Full notes on GitHub
          </button>
          {primary && (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                actions.setNotesOpen(false);
                void primary.run();
              }}
              data-testid="release-notes-update"
            >
              {primary.label}
            </button>
          )}
        </footer>
      </div>
    </Scrim>
  );
}
