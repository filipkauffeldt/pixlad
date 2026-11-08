// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import { BLOCK_SIZE_PX, blockSizePxToRel, blockSizeRelToPx } from '../shared/block-size';
import type { ExportTarget } from '../shared/ipc';
import { countAreas } from './retouch';
import {
  actions,
  hasMosaic,
  longEdgeOf,
  unexportedCount,
  useApp,
  type PhotoState,
  type Tool,
} from './store';

const TOOLS: Array<{ tool: Tool; label: string; title: string }> = [
  { tool: 'faces', label: 'Faces', title: 'Drag around faces to find them (hold Alt for a lasso)' },
  { tool: 'rect', label: 'Rectangle', title: 'Drag a rectangle to pixelate' },
  { tool: 'lasso', label: 'Lasso', title: 'Draw a freehand outline to pixelate' },
];

/** A typed value next to a slider: keeps a draft until Enter or blur, then clamps. */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (): void => {
    const parsed = Math.round(Number(draft));
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    onCommit(next);
  };
  return (
    <input
      className="numberField mono"
      inputMode="numeric"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(String(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const EXPORT_TARGETS: Array<{ target: ExportTarget; label: string; note: string }> = [
  { target: 'suffix', label: 'Add _edit to the file name', note: 'The original stays as it is.' },
  {
    target: 'overwrite',
    label: 'Overwrite the original',
    note: 'The mosaic replaces the original file. This cannot be undone.',
  },
];

function Settings({ exporting }: { exporting: boolean }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  return (
    <div className="settings" ref={root}>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="settings"
      >
        Settings
      </button>
      {open && (
        <div className="settingsPanel" data-testid="settings-panel">
          <fieldset disabled={exporting}>
            <legend className="label">Export</legend>
            {EXPORT_TARGETS.map(({ target, label, note }) => (
              <label className="radio" key={target}>
                <input
                  type="radio"
                  name="export-target"
                  checked={app.exportTarget === target}
                  onChange={() => void actions.setExportTarget(target)}
                  data-testid={`export-target-${target}`}
                />
                <span>
                  {label}
                  <small>{note}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="label">Updates</legend>
            <label className="radio">
              <input
                type="checkbox"
                checked={app.checkForUpdates}
                onChange={(e) => void actions.setCheckForUpdates(e.target.checked)}
                data-testid="check-for-updates"
              />
              <span>
                Check for updates on start
                <small>Asks GitHub whether a newer version exists.</small>
              </span>
            </label>
          </fieldset>
          <button
            type="button"
            className="linkButton"
            onClick={() => {
              setOpen(false);
              actions.setAboutOpen(true);
            }}
            data-testid="open-about"
          >
            About Pixlad
          </button>
        </div>
      )}
    </div>
  );
}

export function Toolbar({ photo }: { photo: PhotoState | undefined }) {
  const app = useApp();
  const counts = photo ? countAreas(photo.areas) : undefined;
  const longEdge = photo ? longEdgeOf(photo) : 1;
  const px = photo
    ? blockSizeRelToPx(blockSizePxToRel(photo.blockPx, longEdge), longEdge)
    : BLOCK_SIZE_PX.min;
  const exporting = app.batch !== undefined && !app.batch.finished;
  const anyMosaic = app.photos.some(hasMosaic);
  void unexportedCount;
  return (
    <div className="toolbar" data-testid="toolbar">
      <div className="group" role="group" aria-label="Tool">
        {TOOLS.map(({ tool, label, title }) => (
          <button
            key={tool}
            type="button"
            className="tab"
            aria-pressed={app.tool === tool}
            title={title}
            data-tool={tool}
            onClick={() => actions.setTool(tool)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="group" role="group" aria-label="Mode">
        {(['add', 'subtract'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className="tab"
            aria-pressed={app.mode === mode}
            title={
              mode === 'add'
                ? 'New areas and faces add mosaic'
                : 'New areas and faces take mosaic away (hold Alt while drawing to flip the mode)'
            }
            data-mode={mode}
            onClick={() => actions.setMode(mode)}
          >
            {mode === 'add' ? 'Add' : 'Subtract'}
          </button>
        ))}
      </div>
      <label
        className="control"
        title="Block edge in pixels of the full-resolution photo. Small selections get larger blocks, so a face stays unrecognisable."
      >
        <span className="label">Block</span>
        <NumberField
          key={`block-${px}`}
          label="Block size in px"
          value={px}
          min={BLOCK_SIZE_PX.min}
          max={BLOCK_SIZE_PX.max}
          onCommit={actions.setBlockPx}
        />
        <span className="unit mono">px</span>
        <input
          type="range"
          aria-label="Mosaic block size"
          min={BLOCK_SIZE_PX.min}
          max={BLOCK_SIZE_PX.max}
          step={1}
          value={px}
          disabled={!photo}
          onChange={(e) => actions.setBlockPx(Number(e.target.value))}
          onPointerUp={(e) => e.currentTarget.blur()}
        />
      </label>
      <label className="control">
        <span className="label">Padding</span>
        <NumberField
          key={`pad-${Math.round((photo?.facePadding ?? 0.15) * 100)}`}
          label="Face padding in percent"
          value={Math.round((photo?.facePadding ?? 0.15) * 100)}
          min={0}
          max={50}
          onCommit={(percent) => actions.setFacePadding(percent / 100)}
        />
        <span className="unit mono">%</span>
        <input
          type="range"
          aria-label="Face padding"
          min={0}
          max={0.5}
          step={0.01}
          value={photo?.facePadding ?? 0.15}
          disabled={!photo}
          onChange={(e) => actions.setFacePadding(Number(e.target.value))}
          onPointerUp={(e) => e.currentTarget.blur()}
        />
      </label>
      <div className="counts mono" data-testid="area-counts">
        {counts && counts.faces.total > 0 && (
          <span data-testid="face-count">{`${counts.faces.on} of ${counts.faces.total} faces on`}</span>
        )}
        {counts && counts.drawn.total > 0 && (
          <span data-testid="drawn-count">{`${counts.drawn.on} of ${counts.drawn.total} areas on`}</span>
        )}
      </div>
      <div className="spacer" />
      <button
        type="button"
        className="btn"
        onClick={actions.undo}
        disabled={!photo || photo.undo.length === 0}
        title="Undo the last change to the areas (Ctrl/⌘+Z)"
      >
        Undo
      </button>
      <button
        type="button"
        className="btn primary"
        onClick={() => void actions.exportCurrent()}
        disabled={!photo || !hasMosaic(photo) || photo.status === 'exporting'}
        title={
          app.exportTarget === 'overwrite'
            ? 'Save the mosaic over the original file (Ctrl/⌘+E)'
            : 'Save this photo with the mosaic next to the original as _edit (Ctrl/⌘+E)'
        }
        data-testid="export"
      >
        Export
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => void actions.exportAll()}
        disabled={!anyMosaic || exporting}
        title="Export every photo that has a mosaic"
        data-testid="export-all"
      >
        Export all
      </button>
      <Settings exporting={exporting} />
    </div>
  );
}
