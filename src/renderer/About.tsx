// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import { SOURCE_URL, type AboutInfo } from '../shared/ipc';
import { actions } from './store';

/** Copyright, the GPL, and every third-party part with its licence text. */
export function About() {
  const [info, setInfo] = useState<AboutInfo | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    window.api.about().then(setInfo, (cause: unknown) => setError(String(cause)));
    close.current?.focus();
    // Capture phase on the window: the app's shortcuts (Delete, Ctrl+E, Z, arrows) never see a
    // key while the dialog is open. Buttons still activate, because that is the default action.
    const onKeyDown = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') actions.setAboutOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const toggle = (key: string): void => setExpanded(expanded === key ? undefined : key);
  const openChromium = (): void => {
    window.api.openChromiumLicenses().catch((cause: unknown) => setError(String(cause)));
  };

  return (
    <div
      className="modalScrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) actions.setAboutOpen(false);
      }}
    >
      <div
        className="modal about"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        data-testid="about"
      >
        <header className="modalHeader">
          <div>
            <h2 id="about-title">Mosaic Retouch</h2>
            <div className="mono muted">{info ? `Version ${info.version}` : ' '}</div>
          </div>
          <button
            ref={close}
            type="button"
            className="close"
            aria-label="Close"
            onClick={() => actions.setAboutOpen(false)}
          >
            ×
          </button>
        </header>
        <div className="modalBody">
          <p>Copyright © 2026 Filip Kauffeldt</p>
          <p className="muted">
            Free software under the GNU General Public License, version 3 or later. It comes with
            ABSOLUTELY NO WARRANTY; you may redistribute it under the terms of that licence.
          </p>
          <p className="muted">
            Source code:{' '}
            <button
              type="button"
              className="inlineLink mono"
              onClick={() => {
                window.api.openSource().catch((cause: unknown) => setError(String(cause)));
              }}
              data-testid="about-source"
            >
              {SOURCE_URL.replace('https://', '')}
            </button>
          </p>
          {error && <p className="errorText">{error}</p>}
          {info && (
            <>
              <button
                type="button"
                className="noticeRow"
                aria-expanded={expanded === 'gpl'}
                onClick={() => toggle('gpl')}
                data-testid="about-gpl"
              >
                <span>Mosaic Retouch</span>
                <span className="mono muted">GPL-3.0-or-later</span>
              </button>
              {expanded === 'gpl' && <pre className="licenseText">{info.license}</pre>}
              <h3 className="label">Open-source parts</h3>
              <ul className="notices" data-testid="about-notices">
                {info.notices.map((notice) => {
                  const match = /^(.*) \((.+)\)$/.exec(notice.title);
                  const name = match ? match[1]! : notice.title;
                  const license = match ? match[2]! : '';
                  return (
                    <li key={notice.title}>
                      <button
                        type="button"
                        className="noticeRow"
                        aria-expanded={expanded === notice.title}
                        onClick={() => toggle(notice.title)}
                      >
                        <span>{name}</span>
                        <span className="mono muted">{license}</span>
                      </button>
                      {expanded === notice.title && (
                        <pre className="licenseText">
                          {notice.homepage ? `${notice.homepage}\n\n${notice.text}` : notice.text}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
              {info.hasChromiumLicenses && (
                <button type="button" className="btn" onClick={openChromium}>
                  Open Chromium licences
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
