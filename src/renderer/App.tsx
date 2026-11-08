// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useCallback, useEffect, useState } from 'react';
import { About } from './About';
import { Stage } from './Stage';
import { Strip } from './Strip';
import { Toolbar } from './Toolbar';
import { UpdateStatus } from './UpdateStatus';
import { actions, currentPhoto, useApp } from './store';

const isMac = navigator.platform.toLowerCase().includes('mac');

export function App() {
  const app = useApp();
  const photo = currentPhoto(app);
  const [zoom, setZoom] = useState<number | undefined>();
  const onZoom = useCallback((percent: number | undefined) => setZoom(percent), []);

  useEffect(() => {
    actions
      .loadSettings()
      .catch((cause: unknown) => {
        actions.notice([`Could not load the settings: ${String(cause)}`], 'error');
      })
      // The main process checks the setting itself, so a failed load does not stop the check.
      .finally(() => void actions.checkForUpdatesOnStart());
  }, []);

  // Drag and drop anywhere on the window.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') === true;
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      actions.setDragging(true);
    };
    const onOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) actions.setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      actions.setDragging(false);
      const paths = window.api.pathsForFiles(Array.from(e.dataTransfer!.files));
      if (paths.length > 0) void actions.addPaths(paths);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // Keyboard. Letters and symbols are matched by `event.key`, never by position, and Alt or AltGr
  // (Ctrl+Alt on Windows and Linux) never triggers anything.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.getModifierState('AltGraph')) return;
      const primary = isMac ? event.metaKey : event.ctrlKey;
      const other = isMac ? event.ctrlKey : event.metaKey;
      if (other) return;
      const target = event.target;
      const typing =
        (target instanceof HTMLInputElement && target.type !== 'range') ||
        target instanceof HTMLTextAreaElement;
      if (primary && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        void actions.exportCurrent();
        return;
      }
      if (typing) return;
      if (primary && (event.key === 'z' || event.key === 'Z') && !event.shiftKey) {
        event.preventDefault();
        actions.undo();
      } else if (!primary && event.key === 'ArrowLeft') {
        event.preventDefault();
        actions.step(-1);
      } else if (!primary && event.key === 'ArrowRight') {
        event.preventDefault();
        actions.step(1);
      } else if (!primary && event.key === 'Delete') {
        event.preventDefault();
        if (app.currentId) actions.remove(app.currentId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [app.currentId]);

  // Messages from the stage that are not failures of an export.
  useEffect(() => {
    const none = (): void => void actions.notice(['No faces found in that area.']);
    const failed = (e: Event): void =>
      void actions.notice([`Face detection failed: ${(e as CustomEvent<string>).detail}`], 'error');
    document.addEventListener('pixlad:no-faces', none);
    document.addEventListener('pixlad:detect-failed', failed);
    return () => {
      document.removeEventListener('pixlad:no-faces', none);
      document.removeEventListener('pixlad:detect-failed', failed);
    };
  }, []);

  const batch = app.batch;
  const batchText = batch
    ? batch.finished
      ? `${batch.ok} exported, ${batch.failed.length} failed`
      : `Exporting ${Math.min(batch.done + 1, batch.total)} of ${batch.total}`
    : '';

  return (
    <div className="app">
      <Toolbar photo={photo} />
      {app.notices.map((notice) => (
        <div className="notice" role="alert" key={notice.id} data-testid="notice">
          <span className={`dot ${notice.kind === 'error' ? 'error' : ''}`} />
          <div className="lines">
            {notice.lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          <button
            type="button"
            className="close"
            aria-label="Dismiss"
            onClick={() => actions.dismissNotice(notice.id)}
          >
            ×
          </button>
        </div>
      ))}
      {app.update.phase !== 'idle' && !app.updatePromptHidden && !app.aboutOpen && (
        <div className="notice update" role="status" data-testid="update-prompt">
          <span className="dot ok" />
          <div className="lines">
            <UpdateStatus update={app.update} withLater />
          </div>
          {app.update.phase === 'opened' && (
            <button
              type="button"
              className="close"
              aria-label="Dismiss"
              onClick={actions.hideUpdatePrompt}
            >
              ×
            </button>
          )}
        </div>
      )}
      <div className="stageWrap">
        {photo ? (
          <Stage key={`${photo.info.id}-${photo.fileVersion}`} photo={photo} onZoom={onZoom} />
        ) : (
          <div className="empty" data-testid="empty">
            <h1>Drop JPEG photos here</h1>
            <p>One or several, or whole folders. Nothing is saved between sessions.</p>
            <button
              type="button"
              className="btn"
              onClick={() => void actions.openDialog()}
              data-testid="open"
            >
              Open…
            </button>
            {app.adding && <p>Adding…</p>}
          </div>
        )}
      </div>
      {app.photos.length > 0 && <Strip />}
      <div className="footer mono" data-testid="footer">
        <span className="status" data-testid="photo-status">
          {app.adding && <span>Adding photos…</span>}
          {photo && (
            <>
              <span>{photo.info.name}</span>
              <span>{`${photo.info.width}×${photo.info.height}`}</span>
              {photo.message && (
                <span>
                  <span
                    className={`dot ${photo.status === 'failed' ? 'error' : photo.status === 'exported' ? 'ok' : ''}`}
                    style={{ display: 'inline-block', marginRight: 6 }}
                  />
                  {photo.message}
                </span>
              )}
            </>
          )}
        </span>
        {batchText && <span data-testid="batch-status">{batchText}</span>}
        {photo && <span>{zoom === undefined ? 'Fit' : `${Math.round(zoom)}%`}</span>}
        <span>
          {app.photos.length > 0 && photo
            ? `${app.photos.indexOf(photo) + 1} / ${app.photos.length}`
            : ''}
        </span>
      </div>
      {app.toasts.length > 0 && (
        <div className="toasts" data-testid="toasts">
          {app.toasts.map((toast) => (
            <div className="toast" role="alert" key={toast.id} data-testid="toast">
              <span className="dot error" />
              <div className="lines">
                {toast.lines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
              <button
                type="button"
                className="close"
                aria-label="Dismiss"
                onClick={() => actions.dismissNotice(toast.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {app.aboutOpen && <About />}
      {app.dragging && <div className="dropOverlay">Drop JPEG photos to add them</div>}
    </div>
  );
}
