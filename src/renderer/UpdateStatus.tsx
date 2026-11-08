// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { actions, useApp, type UpdateState } from './store';

/**
 * What the app says about an update and the buttons that go with it. The prompt under the
 * toolbar and the About dialog both show it, so they always agree.
 */
export function UpdateStatus({
  update,
  withLater,
}: {
  update: Exclude<UpdateState, { phase: 'idle' }>;
  /** The prompt can be put off. The About dialog has nothing to put off. */
  withLater: boolean;
}) {
  const hasNotes = (useApp().updateNotes?.length ?? 0) > 0;
  const notes = hasNotes && (
    <button
      type="button"
      className="btn"
      onClick={() => actions.setNotesOpen(true)}
      data-testid="update-notes"
    >
      What's new
    </button>
  );
  const later = withLater && (
    <button
      type="button"
      className="btn"
      onClick={actions.hideUpdatePrompt}
      data-testid="update-later"
    >
      Later
    </button>
  );
  switch (update.phase) {
    case 'available':
      return (
        <>
          <span data-testid="update-text">{`Pixlad ${update.version} is available.`}</span>
          <button
            type="button"
            className="btn primary"
            onClick={() => void actions.startUpdate()}
            data-testid="update-start"
          >
            Update
          </button>
          {notes}
          {later}
        </>
      );
    case 'downloading':
      return (
        <>
          <span data-testid="update-text">{`Downloading Pixlad ${update.version}…`}</span>
          <span className="mono" data-testid="update-percent">
            {update.percent === undefined ? '' : `${update.percent}%`}
          </span>
          {update.percent !== undefined && (
            <progress className="updateProgress" max={100} value={update.percent} />
          )}
        </>
      );
    case 'ready':
      return (
        <>
          <span data-testid="update-text">{`Pixlad ${update.version} is ready to install.`}</span>
          <button
            type="button"
            className="btn primary"
            onClick={() => void actions.installUpdate()}
            data-testid="update-restart"
          >
            Restart to update
          </button>
          {notes}
          {later}
        </>
      );
    case 'opened':
      return (
        <span data-testid="update-text">
          {`Pixlad ${update.version} is in your Downloads folder as ${update.fileName}, and it is open.`}
        </span>
      );
    case 'failed':
      return (
        <>
          <span className="errorText" data-testid="update-text">
            {`Could not download Pixlad ${update.version}: ${update.message}`}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => void actions.startUpdate()}
            data-testid="update-start"
          >
            Try again
          </button>
          {later}
        </>
      );
  }
}
