// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { Scrim, useModalKeys } from './modal';
import { actions } from './store';

export function RemovePhoto({ question }: { question: { id: string; name: string } }) {
  useModalKeys({ Escape: () => actions.answerRemovePhoto(false) });

  return (
    <Scrim>
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-photo-title"
        aria-describedby="remove-photo-detail"
        data-testid="remove-photo"
      >
        <div className="modalBody">
          <h2 id="remove-photo-title">{`Remove ${question.name} from the session?`}</h2>
          <p id="remove-photo-detail" className="muted">
            Its areas have not been exported and will be lost.
          </p>
        </div>
        <footer className="modalFooter end">
          <button
            type="button"
            className="btn primary"
            autoFocus
            onClick={() => actions.answerRemovePhoto(false)}
            data-testid="remove-photo-keep"
          >
            Keep
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => actions.answerRemovePhoto(true)}
            data-testid="remove-photo-remove"
          >
            Remove
          </button>
        </footer>
      </div>
    </Scrim>
  );
}
