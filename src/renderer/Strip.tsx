// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import { isMac } from './flips';
import { Icon } from './Icon';
import { actions, hasMosaic, useApp, type PhotoState } from './store';

/** A thumbnail and the gap after it. */
const THUMB = 76;
const ITEM = THUMB + 8;
/** Room at the ends, so the current photo's frame is never cut off. */
const EDGE = 8;

/**
 * The photo's state, as one badge in its corner: failed, exported or has a mosaic. An export
 * under way runs a line along the bottom instead.
 */
function Badges({ photo }: { photo: PhotoState }) {
  if (photo.status === 'exporting') {
    return (
      <span className="thumbProgress" aria-label="Exporting" data-testid="badge-exporting">
        <span />
      </span>
    );
  }
  if (photo.status === 'failed') {
    return (
      <span className="badge failed" title="Export failed" data-testid="badge-failed">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-label="Export failed">
          <path d="M5 1.5v4.2M5 8v.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </span>
    );
  }
  if (photo.status === 'exported' && photo.exportedRev === photo.rev) {
    return (
      <span className="badge ok" title="Exported" data-testid="badge-exported">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-label="Exported">
          <path d="M1.5 5.3l2.3 2.3L8.5 2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </span>
    );
  }
  if (hasMosaic(photo)) {
    return (
      <span className="badge" title="Has a mosaic" data-testid="badge-mosaic">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-label="Has a mosaic">
          <path d="M0 0h5v5H0zM5 5h5v5H5z" fill="currentColor" />
          <path d="M5.5 .5h4v4h-4zM.5 5.5h4v4h-4z" fill="none" stroke="currentColor" />
        </svg>
      </span>
    );
  }
  return null;
}

/** A virtualised strip: only the thumbnails in view exist, so hundreds of photos stay cheap. */
export function Strip() {
  const app = useApp();
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ left: 0, width: 1200 });

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = (): void => setRange({ left: element.scrollLeft, width: element.clientWidth });
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, []);

  // A plain vertical wheel over the strip scrolls it sideways: a vertical wheel has nowhere
  // else to go here. Horizontal wheel and trackpad movement are left to the browser.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientWidth
            : 1;
      element.scrollLeft += (event.deltaY + event.deltaX) * unit;
      event.preventDefault();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const content = app.photos.length * ITEM - 8;
  const start = EDGE;

  // Keep the current photo in view when stepping with the arrow keys.
  useEffect(() => {
    const element = scroller.current;
    const index = app.photos.findIndex((p) => p.info.id === app.currentId);
    if (!element || index < 0) return;
    const left = start + index * ITEM;
    if (left < element.scrollLeft + EDGE) element.scrollLeft = Math.max(0, left - EDGE);
    else if (left + THUMB > element.scrollLeft + element.clientWidth - EDGE) {
      element.scrollLeft = left + THUMB - element.clientWidth + EDGE;
    }
  }, [app.currentId, app.photos, start]);

  const first = Math.max(0, Math.floor((range.left - start) / ITEM) - 2);
  const last = Math.min(app.photos.length, Math.ceil((range.left + range.width) / ITEM) + 2);
  // A few photos sit centred, with Add after them; more than fit scroll, and Add stays at the end.
  return (
    <div className="stripBar">
      <div
        className="strip"
        ref={scroller}
        style={{ width: start * 2 + content }}
        data-count={app.photos.length}
        data-testid="strip"
      >
        <div className="stripInner" style={{ width: start * 2 + content }}>
          {app.photos.slice(first, last).map((photo, i) => {
            const index = first + i;
            return (
              <div key={photo.info.id} className="thumbSlot" style={{ left: start + index * ITEM }}>
                <button
                  type="button"
                  className="thumb"
                  aria-current={photo.info.id === app.currentId}
                  aria-label={photo.info.name}
                  title={photo.info.name}
                  data-testid="thumb"
                  data-name={photo.info.name}
                  onClick={() => actions.select(photo.info.id)}
                >
                  <img
                    src={`pixlad://thumb/${photo.info.id}?v=${photo.fileVersion}`}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                  <Badges photo={photo} />
                </button>
                <button
                  type="button"
                  className="remove"
                  aria-label={`Remove ${photo.info.name} from the session`}
                  title="Remove from the session. The file stays on disk."
                  data-testid="remove"
                  data-name={photo.info.name}
                  onClick={() => actions.remove(photo.info.id)}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                    <path d="M1 1l6 6M7 1 1 7" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {app.adding && (
        <span className="thumbPlaceholder" title="Adding photos…" data-testid="adding">
          <span className="spinner" aria-hidden="true" />
        </span>
      )}
      <button
        type="button"
        className="addPhotos"
        onClick={() => void actions.openDialog()}
        aria-label="Add photos"
        title={`Add photos to this session (${isMac ? '⌘' : 'Ctrl'}+O)`}
        data-testid="add-photos"
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
