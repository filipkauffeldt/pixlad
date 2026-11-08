// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { app, net, shell } from 'electron';
import electronUpdater, { type AppUpdater } from 'electron-updater';
import { RELEASES_OWNER, RELEASES_REPO } from '../shared/update';
import { isPrerelease, parseVersion } from '../shared/version';
import {
  GithubDmgSource,
  parseTestUpdates,
  UpdateService,
  type TestUpdates,
  type UpdateSource,
} from './update-sources';

/**
 * Windows and Fedora: electron-updater checks GitHub, downloads the installer and installs it. It
 * never downloads by itself and never installs when the app quits, so the user decides.
 */
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
    // Stable releases only, however the feed is set up.
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
    // Not silent, so the installer shows what it does, and the app starts again afterwards.
    this.updater.quitAndInstall(false, true);
  }
}

function createUpdater(platform: NodeJS.Platform, test: TestUpdates | undefined): AppUpdater {
  // The two classes are named here, not picked by electron-updater, because only these two kinds
  // of package are built.
  const updater =
    platform === 'win32' ? new electronUpdater.NsisUpdater() : new electronUpdater.RpmUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  if (test) {
    updater.forceDevUpdateConfig = true;
    updater.setFeedURL({ provider: 'generic', url: test.url });
    // The version is a read-only SemVer made by the library. Make another one of the same class.
    const SemVer = updater.currentVersion.constructor as new (
      version: string,
    ) => typeof updater.currentVersion;
    (updater as { currentVersion: unknown }).currentVersion = new SemVer(test.version);
  } else {
    updater.setFeedURL({ provider: 'github', owner: RELEASES_OWNER, repo: RELEASES_REPO });
  }
  return updater;
}

/**
 * The update service for this run. Only a packaged release build looks for updates: a source
 * run and the prerelease builds from pull requests and `main` (`0.0.0-dev.<n>`) never do. A test
 * can switch it on for a source run with PIXLAD_TEST_UPDATES, which a packaged app ignores.
 */
export function createUpdateService(): UpdateService {
  const test = app.isPackaged ? undefined : parseTestUpdates(process.env['PIXLAD_TEST_UPDATES']);
  const currentVersion = test?.version ?? app.getVersion();
  const version = parseVersion(currentVersion);
  if (!test && !(app.isPackaged && version && !isPrerelease(version))) {
    return new UpdateService(undefined);
  }
  const platform = test?.platform ?? process.platform;
  if (platform === 'darwin') {
    const apiUrl = test?.url ?? `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}`;
    return new UpdateService(
      new GithubDmgSource({
        apiUrl,
        currentVersion,
        // A test on another system gets the one build that exists for a Mac.
        arch: test ? 'arm64' : process.arch,
        fetch: net.fetch.bind(net) as typeof fetch,
        downloadsDir: app.getPath('downloads'),
        openPath: (path) => shell.openPath(path),
      }),
    );
  }
  if (platform === 'win32' || platform === 'linux') {
    return new UpdateService(
      new ElectronUpdaterSource(createUpdater(platform, test), currentVersion),
    );
  }
  return new UpdateService(undefined);
}
