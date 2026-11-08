// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import type { ExportNames, ExportTarget } from '../shared/ipc';
import { actions, hasMosaic, useApp } from './store';

/**
 * The first-export choice, under the button that opened it: New copy or Replace original, with
 * the file name the export will write or replace. The choice is saved, so it shows once.
 */
export function ExportChoice({ anchor }: { anchor: 'export' | 'all' }) {
  const app = useApp();
  const [target, setTarget] = useState<ExportTarget>(app.exportTarget);
  const [names, setNames] = useState<ExportNames | undefined>();
  const root = useRef<HTMLDivElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);

  const ids =
    anchor === 'all'
      ? app.photos.filter(hasMosaic).map((p) => p.info.id)
      : app.currentId
        ? [app.currentId]
        : [];
  const count = ids.length;
  const exampleId = ids[0];

  useEffect(() => {
    if (!exampleId) return;
    window.api.exportNames(exampleId).then(setNames, () => setNames(undefined));
  }, [exampleId]);

  // Capture phase: the app's shortcuts (Delete, Z, arrows, Ctrl+E) never see a key while this
  // is open. Arrow keys still move between the options, because that is their default action.
  const chosen = useRef(target);
  useEffect(() => {
    chosen.current = target;
  }, [target]);
  useEffect(() => {
    exportButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        actions.cancelExportChoice();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void actions.chooseExportTarget(chosen.current);
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) actions.cancelExportChoice();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  const many = count > 1;
  const file = names ? (target === 'suffix' ? names.copy : names.source) : '…';
  return (
    <div
      className="exportChoice"
      ref={root}
      role="dialog"
      aria-labelledby="export-choice-title"
      data-testid="export-choice"
    >
      <h3 id="export-choice-title">How should Pixlad save?</h3>
      {(['suffix', 'overwrite'] as const).map((value) => (
        <label className="radio" key={value}>
          <input
            type="radio"
            name="export-choice"
            checked={target === value}
            onChange={() => setTarget(value)}
            data-testid={`export-choice-${value}`}
          />
          <span>{value === 'suffix' ? 'New copy' : 'Replace original'}</span>
        </label>
      ))}
      <div className="exportResult" data-testid="export-choice-result">
        {target === 'suffix' ? (
          <span>{many ? `Saves ${count} photos, for example` : 'Saves as'}</span>
        ) : (
          <span>
            {many ? `Replaces ${count} originals, for example` : 'Replaces'}{' '}
            <span className="warn">(cannot be undone)</span>
          </span>
        )}
        <span className="mono fileName">{file}</span>
      </div>
      <div className="exportChoiceFoot">
        <span className="hint">Change in Settings.</span>
        <button
          ref={exportButton}
          type="button"
          className="btn primary"
          onClick={() => void actions.chooseExportTarget(target)}
          data-testid="export-choice-confirm"
        >
          {many ? `Export ${count}` : 'Export'}
        </button>
      </div>
    </div>
  );
}
