// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BLOCK_SIZE_PX, blockSizePxToRel, blockSizeRelToPx } from '../shared/block-size';
import type { ExportTarget, Theme } from '../shared/ipc';
import { ExportChoice } from './ExportChoice';
import { isMac, useFlips } from './flips';
import { countAreas, withFlips, type Outline } from './retouch';
import {
  actions,
  hasMosaic,
  longEdgeOf,
  unexportedCount,
  useApp,
  type PhotoState,
  type Target,
} from './store';

const TARGETS: Array<{ target: Target; label: string; title: string }> = [
  { target: 'faces', label: 'Faces', title: 'Drag around faces to find them' },
  { target: 'area', label: 'Area', title: 'Drag to draw an area to pixelate' },
];
const OUTLINES: Array<{ outline: Outline; label: string; title: string }> = [
  { outline: 'rect', label: 'Rectangle', title: 'Drag a rectangle (hold Alt for a lasso)' },
  { outline: 'lasso', label: 'Lasso', title: 'Draw a freehand outline (hold Alt for a rectangle)' },
];
const FLIP_KEY = isMac ? '⌘' : 'Ctrl';

/** Picks what a drag acts on. */
function TargetMenu() {
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
  const current = TARGETS.find((t) => t.target === app.target)!;
  return (
    <div className="targetMenu" ref={root}>
      <button
        type="button"
        className="btn dropdown"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current.title}
        data-testid="target"
        onClick={() => setOpen(!open)}
      >
        <span className="dropdownLabel">
          {TARGETS.map(({ target, label }) => (
            <span key={target} data-current={target === app.target ? '' : undefined}>
              {label}
            </span>
          ))}
        </span>
        <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
          <path d="M1 3l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="menu">
          {TARGETS.map(({ target, label, title }) => (
            <button
              key={target}
              type="button"
              role="menuitemradio"
              aria-checked={app.target === target}
              className="menuItem"
              title={title}
              data-target={target}
              onClick={() => {
                actions.setTarget(target);
                setOpen(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  {
    target: 'suffix',
    label: 'New copy',
    note: 'Saves a copy with _edit in its name. The original stays as it is.',
  },
  { target: 'overwrite', label: 'Replace original', note: 'Cannot be undone.' },
];

const THEMES: Array<{ theme: Theme; label: string; icon: ReactNode }> = [
  {
    theme: 'light',
    label: 'Light',
    icon: (
      <g strokeLinecap="round">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
      </g>
    ),
  },
  {
    theme: 'dark',
    label: 'Dark',
    icon: (
      <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" strokeLinejoin="round" />
    ),
  },
  {
    theme: 'system',
    label: 'Match system',
    icon: (
      <g strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.75" y="2.5" width="12.5" height="8.5" />
        <path d="M5.5 14h5M8 11v3" />
      </g>
    ),
  },
];

/** Light, dark or the system's choice, as three icon buttons that act as one radio group. */
function ThemePicker() {
  const app = useApp();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const current = THEMES.findIndex(({ theme }) => theme === app.theme);
  const pick = (index: number): void => {
    void actions.setTheme(THEMES[index]!.theme);
    buttons.current[index]?.focus();
  };
  return (
    <div className="appearance">
      <span className="label" id="appearance-label">
        Appearance
      </span>
      <div
        className="themePicker"
        role="radiogroup"
        aria-labelledby="appearance-label"
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
          if (step === undefined) return;
          // Kept from the window, where Left and Right step through the photos.
          e.preventDefault();
          e.stopPropagation();
          pick((current + step + THEMES.length) % THEMES.length);
        }}
      >
        {THEMES.map(({ theme, label, icon }, index) => (
          <button
            key={theme}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={app.theme === theme}
            aria-label={label}
            title={label}
            tabIndex={app.theme === theme ? 0 : -1}
            onClick={() => pick(index)}
            data-testid={`theme-${theme}`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              aria-hidden="true"
            >
              {icon}
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

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
          <ThemePicker />
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
              actions.setShortcutsOpen(true);
            }}
            data-testid="open-shortcuts"
          >
            Keyboard shortcuts
          </button>
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
  const flips = useFlips();
  const active = withFlips(app, flips);
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
        <TargetMenu />
        {OUTLINES.map(({ outline, label, title }) => (
          <button
            key={outline}
            type="button"
            className="tab"
            aria-pressed={active.outline === outline}
            data-flipped={flips.outline && active.outline === outline ? '' : undefined}
            title={title}
            data-outline={outline}
            onClick={() => actions.setOutline(outline)}
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
            aria-pressed={active.mode === mode}
            data-flipped={flips.mode && active.mode === mode ? '' : undefined}
            title={
              mode === 'add'
                ? `New areas and faces add mosaic (hold ${FLIP_KEY} to subtract)`
                : `New areas and faces take mosaic away (hold ${FLIP_KEY} to add)`
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
        className="btn"
        onClick={actions.reset}
        disabled={!photo || photo.areas.length === 0}
        title="Clear every area and face on this photo (Undo brings them back)"
        data-testid="reset"
      >
        Reset
      </button>
      <span className="anchor">
        <button
          type="button"
          className="btn primary"
          onClick={() => void actions.exportCurrent()}
          disabled={!photo || !hasMosaic(photo) || photo.status === 'exporting'}
          title={
            app.exportTarget === 'overwrite'
              ? 'Replace the original file with the mosaic (Ctrl/⌘+E)'
              : 'Save a new copy with _edit next to the original (Ctrl/⌘+E)'
          }
          data-testid="export"
        >
          Export
        </button>
        {app.exportChoice?.anchor === 'export' && <ExportChoice anchor="export" />}
      </span>
      <span className="anchor">
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
        {app.exportChoice?.anchor === 'all' && <ExportChoice anchor="all" />}
      </span>
      <Settings exporting={exporting} />
    </div>
  );
}
