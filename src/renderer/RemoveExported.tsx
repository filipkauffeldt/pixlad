// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect } from 'react';
import { actions } from './store';

/** After an export: take the exported photos out of the session, or keep them? */
export function RemoveExported({
  question,
}: {
  question: { count: number; name: string | undefined };
}) {
  useEffect(() => {
    // Capture phase: the app's shortcuts (Delete, Ctrl+E, Z, arrows) never see a key while the
    // question is open. Buttons still activate, because that is the default action.
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') actions.answerRemove(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const title =
    question.count === 1 && question.name
      ? `Remove ${question.name} from the session?`
      : `Remove ${question.count} exported photos from the session?`;
  return (
    <div className="modalScrim">
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-title"
        aria-describedby="remove-detail"
        data-testid="remove-exported"
      >
        <div className="modalBody">
          <h2 id="remove-title">{title}</h2>
          <p id="remove-detail" className="muted">
            The files stay on disk.
          </p>
        </div>
        <footer className="modalFooter end">
          <button
            type="button"
            className="btn"
            onClick={() => actions.answerRemove(false)}
            data-testid="remove-exported-keep"
          >
            Keep
          </button>
          <button
            type="button"
            className="btn primary"
            autoFocus
            onClick={() => actions.answerRemove(true)}
            data-testid="remove-exported-remove"
          >
            Remove
          </button>
        </footer>
      </div>
    </div>
  );
}
