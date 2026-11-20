// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useRef, useState } from 'react';
import icon from '../../build/icon.svg';
import { SOURCE_URL, type AboutInfo, type Notice } from '../shared/ipc';
import { Icon } from './Icon';
import { UpdateStatus } from './UpdateStatus';
import { actions, useApp, type AboutCheck } from './store';

function aboutCheckText(check: AboutCheck): string {
  switch (check.phase) {
    case 'checking':
      return 'Checking…';
    case 'up-to-date':
      return 'Pixlad is up to date';
    case 'error':
      return `Could not check for updates: ${check.message}`;
    case 'idle':
      return '';
  }
}

type Group = 'models' | 'runtimes' | 'fonts' | 'packages';
const GROUPS: Array<{ group: Group; title: string }> = [
  { group: 'models', title: 'Models' },
  { group: 'runtimes', title: 'Runtimes' },
  { group: 'fonts', title: 'Fonts' },
  { group: 'packages', title: 'Packages' },
];

/** Where a part is listed: the face models, what runs the app, the fonts, or an npm package. */
const groupOf = (title: string): Group =>
  title.startsWith('@fontsource')
    ? 'fonts'
    : /model/i.test(title)
      ? 'models'
      : /^\S+ \d+\.\d+\.\d+ \(/.test(title)
        ? 'packages'
        : 'runtimes';

/** A notice title is "name (licence)"; a few have no licence in the title. */
function split(notice: Notice): { name: string; license: string } {
  const match = /^(.*) \((.+)\)$/.exec(notice.title);
  return match ? { name: match[1]!, license: match[2]! } : { name: notice.title, license: '' };
}

/** Every part with its licence: a filterable list, and the selected licence beside it. */
function Licences({ info, onOpenChromium }: { info: AboutInfo; onOpenChromium: () => void }) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string>('gpl');
  const parts = info.notices.map((notice) => ({ notice, ...split(notice) }));
  const shown = parts.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const current = parts.find((p) => p.notice.title === selected);
  const row = (key: string, name: string, license: string, testId?: string) => (
    <button
      key={key}
      type="button"
      className="noticeRow"
      aria-pressed={selected === key}
      onClick={() => setSelected(key)}
      data-testid={testId}
    >
      <span>{name}</span>
      <span className="mono muted">{license}</span>
    </button>
  );
  return (
    <div className="licences">
      <div className="licenceList">
        <input
          className="licenceFilter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${parts.length + 1} parts`}
          aria-label="Filter the parts"
        />
        <div className="licenceScroll" data-testid="about-notices">
          <h3 className="label">Pixlad</h3>
          {row('gpl', 'Pixlad', 'GPL-3.0-or-later', 'about-gpl')}
          {GROUPS.map(({ group, title }) => {
            const inGroup = shown.filter((p) => groupOf(p.notice.title) === group);
            if (inGroup.length === 0) return null;
            return (
              <section key={group}>
                <h3 className="label">
                  {group === 'packages' ? `${title} · ${inGroup.length}` : title}
                </h3>
                {inGroup.map((p) => row(p.notice.title, p.name, p.license))}
              </section>
            );
          })}
        </div>
      </div>
      <div className="licencePane">
        {current ? (
          <>
            <h3>{current.name}</h3>
            <div className="meta mono">
              {[current.license, current.notice.homepage].filter(Boolean).join(' · ')}
            </div>
            {groupOf(current.notice.title) === 'runtimes' &&
              /chromium/i.test(current.name) &&
              info.hasChromiumLicenses && (
                <button type="button" className="btn" onClick={onOpenChromium}>
                  Open Chromium licences
                </button>
              )}
            <pre className="licenseText">{current.notice.text}</pre>
          </>
        ) : (
          <>
            <h3>Pixlad</h3>
            <div className="meta mono">GPL-3.0-or-later</div>
            <pre className="licenseText">{info.license}</pre>
          </>
        )}
      </div>
    </div>
  );
}

/** Copyright, the GPL, and every third-party part with its licence text. */
export function About() {
  const app = useApp();
  const [info, setInfo] = useState<AboutInfo | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<'about' | 'licences'>('about');
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
        className={view === 'about' ? 'modal about' : 'modal about licencesView'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        data-testid="about"
      >
        <header className="modalHeader">
          {view === 'about' ? (
            <img className="aboutIcon" src={icon} alt="" width={36} height={36} />
          ) : (
            <div className="licencesTitle">
              <button
                type="button"
                className="iconBtn back"
                aria-label="Back to About"
                onClick={() => setView('about')}
                data-testid="licences-back"
              >
                <Icon name="chevron" size={18} />
              </button>
              <h2 id="about-title">Open-source licences</h2>
            </div>
          )}
          <button
            ref={close}
            type="button"
            className="iconBtn"
            aria-label="Close"
            onClick={() => actions.setAboutOpen(false)}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        {view === 'licences' && info ? (
          <Licences info={info} onOpenChromium={openChromium} />
        ) : (
          <div className="modalBody">
            <h2 id="about-title">Pixlad</h2>
            <p className="mono muted">{info ? `Version ${info.version}` : ' '}</p>
            <p className="aboutCopy">Copyright © 2026 Filip Kauffeldt</p>
            <p className="muted">
              Free software under the GNU General Public License, version 3 or later. It comes with
              ABSOLUTELY NO WARRANTY. You may share and change it under the terms of that licence.
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
            <div className="aboutActions">
              {info?.canCheckForUpdates ? (
                <div className="updateRow" data-testid="about-update">
                  {app.update.phase === 'idle' ? (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={app.aboutCheck.phase === 'checking'}
                        onClick={() => void actions.checkForUpdates()}
                        data-testid="about-check-updates"
                      >
                        Check for updates
                      </button>
                      <span
                        className={app.aboutCheck.phase === 'error' ? 'errorText' : 'muted'}
                        role="status"
                        data-testid="about-update-result"
                      >
                        {aboutCheckText(app.aboutCheck)}
                      </span>
                    </>
                  ) : (
                    <UpdateStatus update={app.update} withLater={false} />
                  )}
                </div>
              ) : (
                info && <p className="muted">This build does not check for updates.</p>
              )}
              {info && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setView('licences')}
                  data-testid="open-licences"
                >
                  Open-source licences
                  <Icon name="chevron" size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
