// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import { actions, currentPhoto, hasMosaic, useApp } from './store';

/** How many file names the dialog lists before it says "and N more". */
const LISTED = 3;

/**
 * Asks before Replace original writes over files. Cancel has the focus, so Enter does not destroy
 * anything. "Don't ask again" lasts until the app closes.
 */
export function OverwriteConfirm({ anchor }: { anchor: 'export' | 'all' }) {
  const app = useApp();
  const [dontAsk, setDontAsk] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);

  const names =
    anchor === 'all'
      ? app.photos.filter(hasMosaic).map((p) => p.info.name)
      : [currentPhoto(app)?.info.name ?? ''];
  const count = names.length;
  const many = count > 1;

  useEffect(() => {
    cancel.current?.focus();
    // Capture phase on the window: the app's shortcuts (Delete, Ctrl+E, Z, arrows) never see a
    // key while the dialog is open. Buttons still activate, because that is the default action.
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        actions.cancelOverwrite();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div
      className="modalScrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) actions.cancelOverwrite();
      }}
    >
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="overwrite-title"
        data-testid="overwrite-confirm"
      >
        <h2 id="overwrite-title" className="confirmTitle">
          {many ? `Replace ${count} originals?` : 'Replace original?'}
        </h2>
        <div className="confirmBody">
          <p className="muted">
            {many
              ? 'The mosaics will be written over these files.'
              : 'The mosaic will be written over this file.'}
          </p>
          <div className="confirmFiles mono">
            {names.slice(0, LISTED).map((name, i) => (
              <div key={i}>{name}</div>
            ))}
            {count > LISTED && <div className="muted">{`and ${count - LISTED} more`}</div>}
          </div>
          <p className="errorText">This cannot be undone.</p>
          <label className="radio muted">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(event) => setDontAsk(event.target.checked)}
              data-testid="overwrite-confirm-dont-ask"
            />
            <span>Don’t ask again this session</span>
          </label>
        </div>
        <div className="confirmFoot">
          <button
            ref={cancel}
            type="button"
            className="btn"
            onClick={actions.cancelOverwrite}
            data-testid="overwrite-confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void actions.confirmOverwrite(dontAsk)}
            data-testid="overwrite-confirm-replace"
          >
            {many ? `Replace ${count}` : 'Replace'}
          </button>
        </div>
      </div>
    </div>
  );
}
