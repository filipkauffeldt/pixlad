// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect } from 'react';
import { actions } from './store';

/** Ask before a photo with unexported areas leaves the session for good. */
export function RemovePhoto({ question }: { question: { id: string; name: string } }) {
  useEffect(() => {
    // Capture phase: the app's shortcuts (Delete, Ctrl+E, Z, arrows) never see a key while the
    // question is open. Buttons still activate, because that is the default action.
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') actions.answerRemovePhoto(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div className="modalScrim">
      <div
        className="modal removePhoto"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-photo-title"
        aria-describedby="remove-photo-detail"
        data-testid="remove-photo"
      >
        <div className="modalBody">
          <h2 id="remove-photo-title">{`Remove ${question.name} from the session?`}</h2>
          <p id="remove-photo-detail" className="muted">
            Its areas have not been exported and will be lost. The file stays on disk.
          </p>
        </div>
        <div className="modalActions">
          <button
            type="button"
            className="btn"
            onClick={() => actions.answerRemovePhoto(false)}
            data-testid="remove-photo-keep"
          >
            Keep
          </button>
          <button
            type="button"
            className="btn primary"
            autoFocus
            onClick={() => actions.answerRemovePhoto(true)}
            data-testid="remove-photo-remove"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
