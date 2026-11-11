// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import { actions, hasMosaic, useApp, type PhotoState } from './store';

const ITEM = 104;

function Badges({ photo }: { photo: PhotoState }) {
  const mosaic = hasMosaic(photo);
  const exported = photo.status === 'exported' && photo.exportedRev === photo.rev;
  if (!mosaic && !exported && photo.status !== 'exporting' && photo.status !== 'failed')
    return null;
  return (
    <span className="badges">
      {mosaic && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-label="Has a mosaic"
          data-testid="badge-mosaic"
        >
          <title>Has a mosaic</title>
          <path d="M0 0h5v5H0zM5 5h5v5H5z" fill="currentColor" />
          <path d="M5 0h5v5H5zM0 5h5v5H0z" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      )}
      {photo.status === 'exporting' && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-label="Exporting"
          data-testid="badge-exporting"
        >
          <title>Exporting</title>
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeDasharray="6 4">
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 5 5"
              to="360 5 5"
              dur="1s"
              repeatCount="indefinite"
            />
          </circle>
        </svg>
      )}
      {exported && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-label="Exported"
          data-testid="badge-exported"
        >
          <title>Exported</title>
          <path d="M1.5 5.5l2.3 2.3L8.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
      {photo.status === 'failed' && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-label="Export failed"
          data-testid="badge-failed"
          style={{ color: 'var(--error)' }}
        >
          <title>Export failed</title>
          <path
            d="M5 1l4.5 8h-9zM5 4v2.5M5 7.6v.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
          />
        </svg>
      )}
    </span>
  );
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

  // Keep the current photo in view when stepping with the arrow keys.
  useEffect(() => {
    const element = scroller.current;
    const index = app.photos.findIndex((p) => p.info.id === app.currentId);
    if (!element || index < 0) return;
    const left = 8 + index * ITEM;
    if (left < element.scrollLeft + 8) element.scrollLeft = Math.max(0, left - 8);
    else if (left + ITEM > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = left + ITEM - element.clientWidth + 8;
    }
  }, [app.currentId, app.photos]);

  const first = Math.max(0, Math.floor((range.left - 8) / ITEM) - 2);
  const last = Math.min(app.photos.length, Math.ceil((range.left + range.width) / ITEM) + 2);
  return (
    <div className="strip" ref={scroller} data-testid="strip">
      <div className="stripInner" style={{ width: 16 + app.photos.length * ITEM }}>
        {app.photos.slice(first, last).map((photo, i) => {
          const index = first + i;
          return (
            <button
              key={photo.info.id}
              type="button"
              className="thumb"
              style={{ left: 8 + index * ITEM }}
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
              <span
                className="remove"
                role="button"
                aria-label={`Remove ${photo.info.name} from the session`}
                title="Remove from the session. The file stays on disk."
                data-testid="remove"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.remove(photo.info.id);
                }}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
