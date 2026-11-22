// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { app, net, shell } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import { isPrerelease, parseVersion } from '../shared/version';
import { chooseUpdater, type UpdaterKind } from './update-assets';
import { resolveUpdateEnvironment, type UpdateEnvironment } from './update-environment';
import {
  fetchReleaseNotes,
  GithubDmgSource,
  UpdateService,
  type UpdateSource,
} from './update-sources';

class ElectronUpdaterSource implements UpdateSource {
  constructor(
    private readonly updater: AppUpdater,
    private readonly currentVersion: string,
  ) {}

  async check(): Promise<string | undefined> {
    const result = await this.updater.checkForUpdates();
    if (!result) throw new Error('updates are not available in this build');
    const version = result.updateInfo.version;
    const next = parseVersion(version);
    const now = parseVersion(this.currentVersion);
    if (!result.isUpdateAvailable || !next || !now || isPrerelease(next)) return undefined;
    return version;
  }

  async download(onProgress: (percent: number | undefined) => void) {
    const listener = (info: { percent: number }): void => onProgress(Math.round(info.percent));
    this.updater.on('download-progress', listener);
    try {
      await this.updater.downloadUpdate();
    } finally {
      this.updater.off('download-progress', listener);
    }
    return { ok: true as const, next: 'restart' as const };
  }

  install(): void {
    const silent = false;
    const runAfterInstall = true;
    this.updater.quitAndInstall(silent, runAfterInstall);
  }
}

function newUpdater(kind: UpdaterKind): AppUpdater {
  switch (kind) {
    case 'nsis':
      return new electronUpdater.NsisUpdater();
    case 'appimage':
      return new electronUpdater.AppImageUpdater();
    case 'rpm':
      return new electronUpdater.RpmUpdater();
  }
}

function overrideCurrentVersion(updater: AppUpdater, version: string): void {
  // electron-updater has no option for this, and an app adapter passed to its constructor leaves it
  // without an HTTP executor.
  const SemVer = updater.currentVersion.constructor as new (
    version: string,
  ) => typeof updater.currentVersion;
  (updater as { currentVersion: unknown }).currentVersion = new SemVer(version);
}

function createUpdater(environment: UpdateEnvironment): AppUpdater {
  const updater = newUpdater(chooseUpdater(environment.platform, process.env, process.execPath));
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.forceDevUpdateConfig = environment.forceDevUpdateConfig;
  updater.setFeedURL(environment.feed);
  overrideCurrentVersion(updater, environment.currentVersion);
  return updater;
}

export function createUpdateService(): UpdateService {
  const environment = resolveUpdateEnvironment(
    {
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    },
    process.env['PIXLAD_TEST_UPDATES'],
  );
  if (!environment.enabled) return new UpdateService(undefined);
  const notes = (version: string) =>
    fetchReleaseNotes(environment.apiUrl, version, net.fetch.bind(net) as typeof fetch);
  if (environment.platform === 'darwin') {
    return new UpdateService(
      new GithubDmgSource({
        apiUrl: environment.apiUrl,
        currentVersion: environment.currentVersion,
        arch: environment.arch,
        fetch: net.fetch.bind(net) as typeof fetch,
        downloadsDir: app.getPath('downloads'),
        openPath: (path) => shell.openPath(path),
      }),
      notes,
    );
  }
  if (environment.platform === 'win32' || environment.platform === 'linux') {
    return new UpdateService(
      new ElectronUpdaterSource(createUpdater(environment), environment.currentVersion),
      notes,
    );
  }
  return new UpdateService(undefined);
}
