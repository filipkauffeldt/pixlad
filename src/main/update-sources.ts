// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { UpdateCheck, UpdateDownload } from '../shared/update';
import { isNewerRelease, isPrerelease, parseVersion } from '../shared/version';
import { chooseInstaller, type ReleaseAsset } from './update-assets';

/** Where a newer version comes from and how it gets onto the machine. */
export interface UpdateSource {
  /** The newer version, or undefined when this one is the latest. */
  check(): Promise<string | undefined>;
  /** Downloads what the last `check` found. */
  download(
    onProgress: (percent: number | undefined) => void,
  ): Promise<UpdateDownload & { ok: true }>;
  /** Restarts into the downloaded version. Only after a download that ended in `restart`. */
  install(): void;
}

/** A failure as one line for the user: the reason, not a stack or a block of headers. */
export function describeError(cause: unknown): string {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const inner = error.cause instanceof Error ? error.cause.message : '';
  const text = (inner || error.message || 'unknown error').split('\n')[0]!.trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * Runs checks and downloads for one source. A check never throws, and two at once share one
 * request. A download needs a check that found something.
 */
export class UpdateService {
  private pending: Promise<UpdateCheck> | undefined;
  private found = false;

  constructor(private readonly source: UpdateSource | undefined) {}

  /** Whether this build can look for updates at all. */
  get enabled(): boolean {
    return this.source !== undefined;
  }

  check(): Promise<UpdateCheck> {
    const source = this.source;
    if (!source) {
      return Promise.resolve({ status: 'error', message: 'this build does not check for updates' });
    }
    this.pending ??= source
      .check()
      .then<UpdateCheck>((version) => {
        this.found = version !== undefined;
        return version === undefined ? { status: 'up-to-date' } : { status: 'available', version };
      })
      .catch<UpdateCheck>((cause: unknown) => {
        this.found = false;
        return { status: 'error', message: describeError(cause) };
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async download(onProgress: (percent: number | undefined) => void): Promise<UpdateDownload> {
    if (!this.source || !this.found)
      return { ok: false, message: 'there is no update to download' };
    try {
      return await this.source.download(onProgress);
    } catch (cause) {
      return { ok: false, message: describeError(cause) };
    }
  }

  install(): void {
    this.source?.install();
  }
}

/** The part of the GitHub releases API this app reads. */
interface LatestRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

function isLatestRelease(value: unknown): value is LatestRelease {
  const release = value as Partial<LatestRelease> | null;
  return (
    typeof release === 'object' &&
    release !== null &&
    typeof release.tag_name === 'string' &&
    Array.isArray(release.assets) &&
    release.assets.every(
      (asset) => typeof asset?.name === 'string' && typeof asset.browser_download_url === 'string',
    )
  );
}

export interface GithubDmgOptions {
  /** `https://api.github.com/repos/<owner>/<repo>`. */
  apiUrl: string;
  currentVersion: string;
  arch: string;
  fetch: typeof fetch;
  downloadsDir: string;
  /** Opens a file with the system's default app. Resolves to an error text, empty on success. */
  openPath: (path: string) => Promise<string>;
}

/**
 * macOS: the app is not signed with a certificate, so Squirrel.Mac cannot install an update. This
 * asks GitHub for the latest release, downloads its .dmg into Downloads and opens it, and the user
 * drags the app to Applications.
 */
export class GithubDmgSource implements UpdateSource {
  private latest: { version: string; asset: ReleaseAsset } | undefined;

  constructor(private readonly options: GithubDmgOptions) {}

  async check(): Promise<string | undefined> {
    this.latest = undefined;
    const response = await this.options.fetch(`${this.options.apiUrl}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Pixlad' },
    });
    if (response.status === 404) throw new Error('GitHub has no release of Pixlad yet');
    if (!response.ok)
      throw new Error(`GitHub answered ${response.status} ${response.statusText}`.trim());
    const release: unknown = await response.json();
    if (!isLatestRelease(release)) throw new Error('GitHub sent a release in an unknown format');
    const version = parseVersion(release.tag_name);
    if (!version)
      throw new Error(`the latest release has no version in its tag "${release.tag_name}"`);
    if (release.draft || release.prerelease || isPrerelease(version)) return undefined;
    if (!isNewerRelease(release.tag_name, this.options.currentVersion)) return undefined;
    const asset = chooseInstaller(release.assets, 'darwin', this.options.arch);
    const text = release.tag_name.replace(/^v/, '');
    if (!asset) throw new Error(`Pixlad ${text} has no download for this Mac`);
    this.latest = { version: text, asset };
    return text;
  }

  async download(onProgress: (percent: number | undefined) => void) {
    const latest = this.latest;
    if (!latest) throw new Error('there is no update to download');
    const response = await this.options.fetch(latest.asset.browser_download_url, {
      headers: { 'User-Agent': 'Pixlad' },
    });
    if (!response.ok || !response.body) {
      throw new Error(`the download answered ${response.status} ${response.statusText}`.trim());
    }
    const total = Number(response.headers.get('content-length')) || latest.asset.size || 0;
    await mkdir(this.options.downloadsDir, { recursive: true });
    const target = await freePath(this.options.downloadsDir, latest.asset.name);
    const partial = `${target}.part`;
    const file = await open(partial, 'w');
    try {
      let received = 0;
      let shown = -1;
      onProgress(total > 0 ? 0 : undefined);
      for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>) {
        await file.write(chunk);
        received += chunk.length;
        const percent = total > 0 ? Math.min(100, Math.floor((received * 100) / total)) : undefined;
        if (percent !== undefined && percent !== shown) {
          shown = percent;
          onProgress(percent);
        }
      }
      if (total > 0 && received !== total) {
        throw new Error(`the download stopped after ${received} of ${total} bytes`);
      }
      await file.close();
      await rename(partial, target);
    } catch (cause) {
      await file.close().catch(() => undefined);
      await rm(partial, { force: true });
      throw cause;
    }
    const failure = await this.options.openPath(target);
    if (failure) throw new Error(`saved ${target} but could not open it: ${failure}`);
    return { ok: true as const, next: 'opened' as const, fileName: basename(target) };
  }

  install(): void {
    throw new Error('the disk image has to be opened, not installed');
  }
}

/** A file name in `dir` that is not taken: `name.dmg`, then `name (1).dmg`, `name (2).dmg`. */
async function freePath(dir: string, name: string): Promise<string> {
  const safe = basename(name);
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  for (let n = 0; ; n++) {
    const path = join(dir, n === 0 ? safe : `${stem} (${n})${extension}`);
    const taken = await stat(path).then(
      () => true,
      () => false,
    );
    if (!taken) return path;
  }
}

/**
 * The test-only hook: a JSON object in PIXLAD_TEST_UPDATES that points update checks at a local
 * server and fixes the version and the system the app pretends to have. The main process reads it
 * only when the app is not packaged.
 */
export interface TestUpdates {
  /** Base URL of the fake server, without a trailing slash. */
  url: string;
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
}

export function parseTestUpdates(text: string | undefined): TestUpdates | undefined {
  if (!text) return undefined;
  const value = JSON.parse(text) as Partial<TestUpdates>;
  if (
    typeof value.url !== 'string' ||
    typeof value.version !== 'string' ||
    !parseVersion(value.version) ||
    (value.platform !== 'darwin' && value.platform !== 'win32' && value.platform !== 'linux')
  ) {
    throw new Error('PIXLAD_TEST_UPDATES needs a url, a version and a platform');
  }
  return { url: value.url.replace(/\/+$/, ''), version: value.version, platform: value.platform };
}
