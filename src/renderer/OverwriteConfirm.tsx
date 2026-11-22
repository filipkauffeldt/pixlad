// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import { Scrim, useModalKeys } from './modal';
import { actions, currentPhoto, hasMosaic, useApp } from './store';

const MAX_LISTED_NAMES = 3;

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
  }, []);
  useModalKeys({
    Escape: (event) => {
      event.preventDefault();
      actions.cancelOverwrite();
    },
  });

  return (
    <Scrim onDismiss={() => actions.cancelOverwrite()}>
      <div
        className="modal confirm overwrite"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="overwrite-title"
        data-testid="overwrite-confirm"
      >
        <h2 id="overwrite-title" className="confirmTitle">
          {many ? `Replace ${count} originals?` : 'Replace original?'}
        </h2>
        <div className="confirmBody">
          <div className="confirmFiles mono">
            {names.slice(0, MAX_LISTED_NAMES).map((name, i) => (
              <div key={i}>{name}</div>
            ))}
            {count > MAX_LISTED_NAMES && (
              <div className="muted">{`and ${count - MAX_LISTED_NAMES} more`}</div>
            )}
          </div>
          <p className="errorText">This cannot be undone.</p>
        </div>
        <div className="confirmFoot">
          <label className="radio muted grow">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(event) => setDontAsk(event.target.checked)}
              data-testid="overwrite-confirm-dont-ask"
            />
            <span>Don’t ask again this session</span>
          </label>
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
            className="btn primary danger"
            onClick={() => void actions.confirmOverwrite(dontAsk)}
            data-testid="overwrite-confirm-replace"
          >
            {many ? `Replace ${count}` : 'Replace'}
          </button>
        </div>
      </div>
    </Scrim>
  );
}
