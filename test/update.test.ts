import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseInstaller, type ReleaseAsset } from '../src/main/update-assets';
import {
  describeError,
  GithubDmgSource,
  parseTestUpdates,
  UpdateService,
  type UpdateSource,
} from '../src/main/update-sources';

const asset = (name: string): ReleaseAsset => ({
  name,
  browser_download_url: `https://example.test/download/${name}`,
});

const RELEASE_FILES = [
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml',
  'pixlad-0.3.0-linux-x86_64.rpm',
  'pixlad-0.3.0-linux-x86_64.rpm.blockmap',
  'pixlad-0.3.0-mac-arm64.dmg',
  'pixlad-0.3.0-mac-arm64.dmg.blockmap',
  'pixlad-0.3.0-win-x64.exe',
  'pixlad-0.3.0-win-x64.exe.blockmap',
].map(asset);

describe('chooseInstaller', () => {
  it.each([
    ['darwin', 'arm64', 'pixlad-0.3.0-mac-arm64.dmg'],
    ['win32', 'x64', 'pixlad-0.3.0-win-x64.exe'],
    ['linux', 'x64', 'pixlad-0.3.0-linux-x86_64.rpm'],
  ] as const)('picks the installer for %s %s', (platform, arch, name) => {
    expect(chooseInstaller(RELEASE_FILES, platform, arch)?.name).toBe(name);
  });

  it('does not depend on the order of the files', () => {
    expect(chooseInstaller([...RELEASE_FILES].reverse(), 'darwin', 'arm64')?.name).toBe(
      'pixlad-0.3.0-mac-arm64.dmg',
    );
  });

  it('never picks a blockmap or an update file', () => {
    const onlyExtras = RELEASE_FILES.filter(
      (file) => file.name.endsWith('.blockmap') || file.name.endsWith('.yml'),
    );
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(chooseInstaller(onlyExtras, platform, platform === 'darwin' ? 'arm64' : 'x64')).toBe(
        undefined,
      );
    }
  });

  it('has nothing for a CPU or a system without a package', () => {
    expect(chooseInstaller(RELEASE_FILES, 'darwin', 'x64')).toBeUndefined();
    expect(chooseInstaller(RELEASE_FILES, 'win32', 'arm64')).toBeUndefined();
    expect(chooseInstaller(RELEASE_FILES, 'freebsd', 'x64')).toBeUndefined();
    expect(chooseInstaller([], 'linux', 'x64')).toBeUndefined();
  });

  it('takes the installer of its own system from a release that has no other', () => {
    expect(chooseInstaller([asset('pixlad-0.3.0-win-x64.exe')], 'linux', 'x64')).toBeUndefined();
    expect(
      chooseInstaller([asset('pixlad-0.3.0-linux-x86_64.rpm')], 'win32', 'x64'),
    ).toBeUndefined();
  });
});

describe('describeError', () => {
  it('keeps the first line and the reason behind a failed fetch', () => {
    expect(describeError(new Error('first\nsecond\nthird'))).toBe('first');
    expect(
      describeError(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND x') })),
    ).toBe('getaddrinfo ENOTFOUND x');
    expect(describeError('plain text')).toBe('plain text');
    expect(describeError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(200);
  });
});

describe('parseTestUpdates', () => {
  it('reads the url, version and platform and trims the slash', () => {
    expect(
      parseTestUpdates('{"url":"http://127.0.0.1:1/","version":"0.2.0","platform":"linux"}'),
    ).toEqual({ url: 'http://127.0.0.1:1', version: '0.2.0', platform: 'linux' });
  });

  it('is undefined when unset and throws on a broken value', () => {
    expect(parseTestUpdates(undefined)).toBeUndefined();
    expect(parseTestUpdates('')).toBeUndefined();
    expect(() => parseTestUpdates('{"url":"x","version":"dev","platform":"linux"}')).toThrow();
    expect(() => parseTestUpdates('{"url":"x","version":"1.0.0","platform":"beos"}')).toThrow();
    expect(() => parseTestUpdates('nope')).toThrow();
  });
});

describe('UpdateService', () => {
  const source = (overrides: Partial<UpdateSource> = {}): UpdateSource => ({
    check: () => Promise.resolve('0.3.0'),
    download: () => Promise.resolve({ ok: true, next: 'restart' }),
    install: () => undefined,
    ...overrides,
  });

  it('turns a check into up-to-date, available or an error and never throws', async () => {
    expect(await new UpdateService(source({ check: async () => undefined })).check()).toEqual({
      status: 'up-to-date',
    });
    expect(await new UpdateService(source()).check()).toEqual({
      status: 'available',
      version: '0.3.0',
    });
    expect(
      await new UpdateService(
        source({ check: () => Promise.reject(new Error('offline\nmore')) }),
      ).check(),
    ).toEqual({ status: 'error', message: 'offline' });
  });

  it('refuses to check when the build has no source', async () => {
    const service = new UpdateService(undefined);
    expect(service.enabled).toBe(false);
    expect((await service.check()).status).toBe('error');
  });

  it('shares one request between checks that overlap', async () => {
    let calls = 0;
    const service = new UpdateService(
      source({
        check: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return '0.3.0';
        },
      }),
    );
    await Promise.all([service.check(), service.check()]);
    expect(calls).toBe(1);
    await service.check();
    expect(calls).toBe(2);
  });

  it('downloads only after a check that found a newer version', async () => {
    let downloads = 0;
    const service = new UpdateService(
      source({
        download: async () => {
          downloads++;
          return { ok: true, next: 'restart' };
        },
      }),
    );
    expect(await service.download(() => undefined)).toMatchObject({ ok: false });
    await service.check();
    expect(await service.download(() => undefined)).toEqual({ ok: true, next: 'restart' });
    expect(downloads).toBe(1);
  });

  it('reports a failed download as a result', async () => {
    const service = new UpdateService(
      source({ download: () => Promise.reject(new Error('disk full')) }),
    );
    await service.check();
    expect(await service.download(() => undefined)).toEqual({ ok: false, message: 'disk full' });
  });
});

describe('GithubDmgSource', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let respond: (url: string) => { status: number; body: string | Buffer; type?: string };
  let opened: string[];
  const dmg = Buffer.alloc(300_000, 7);

  const release = (tag: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [
        {
          name: `pixlad-${tag.slice(1)}-mac-arm64.dmg`,
          browser_download_url: `${base}/download/pixlad-${tag.slice(1)}-mac-arm64.dmg`,
          size: dmg.length,
        },
        { name: 'latest-mac.yml', browser_download_url: `${base}/download/latest-mac.yml` },
      ],
      ...extra,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pixlad-update-'));
    opened = [];
    respond = () => ({ status: 404, body: '' });
    server = createServer((req, res) => {
      const { status, body, type } = respond(req.url ?? '');
      res.writeHead(status, { 'Content-Type': type ?? 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const make = (currentVersion = '0.2.0', arch = 'arm64') =>
    new GithubDmgSource({
      apiUrl: base,
      currentVersion,
      arch,
      fetch,
      downloadsDir: join(dir, 'Downloads'),
      openPath: async (path) => {
        opened.push(path);
        return '';
      },
    });

  it('finds a newer release', async () => {
    respond = () => ({ status: 200, body: release('v0.3.0') });
    expect(await make('0.2.0').check()).toBe('0.3.0');
  });

  it('finds nothing when the latest release is the same, older or a prerelease', async () => {
    respond = () => ({ status: 200, body: release('v0.3.0') });
    expect(await make('0.3.0').check()).toBeUndefined();
    expect(await make('1.0.0').check()).toBeUndefined();
    respond = () => ({ status: 200, body: release('v0.4.0', { prerelease: true }) });
    expect(await make('0.3.0').check()).toBeUndefined();
    respond = () => ({ status: 200, body: release('v0.4.0-rc.1') });
    expect(await make('0.3.0').check()).toBeUndefined();
    respond = () => ({ status: 200, body: release('v0.4.0', { draft: true }) });
    expect(await make('0.3.0').check()).toBeUndefined();
  });

  it('compares versions as numbers', async () => {
    respond = () => ({ status: 200, body: release('v0.10.0') });
    expect(await make('0.9.0').check()).toBe('0.10.0');
  });

  it('asks the latest-release endpoint of the repository', async () => {
    const urls: string[] = [];
    respond = (url) => {
      urls.push(url);
      return { status: 200, body: release('v0.3.0') };
    };
    await make().check();
    expect(urls).toEqual(['/releases/latest']);
  });

  it('fails with a reason on an error status, no release or odd data', async () => {
    respond = () => ({ status: 500, body: 'boom' });
    await expect(make().check()).rejects.toThrow('GitHub answered 500');
    respond = () => ({ status: 404, body: '{}' });
    await expect(make().check()).rejects.toThrow('no release');
    respond = () => ({ status: 200, body: '{"tag_name":5}' });
    await expect(make().check()).rejects.toThrow('unknown format');
    respond = () => ({ status: 200, body: release('nightly') });
    await expect(make().check()).rejects.toThrow('no version');
  });

  it('fails when the release has no download for this Mac', async () => {
    respond = () => ({ status: 200, body: release('v0.3.0') });
    await expect(make('0.2.0', 'x64').check()).rejects.toThrow('no download for this Mac');
  });

  it('downloads the dmg into the folder with progress, then opens it', async () => {
    respond = (url) =>
      url.startsWith('/download/')
        ? { status: 200, body: dmg, type: 'application/octet-stream' }
        : { status: 200, body: release('v0.3.0') };
    const source = make();
    await source.check();
    const progress: Array<number | undefined> = [];
    const result = await source.download((percent) => progress.push(percent));
    expect(result).toEqual({ ok: true, next: 'opened', fileName: 'pixlad-0.3.0-mac-arm64.dmg' });
    const path = join(dir, 'Downloads', 'pixlad-0.3.0-mac-arm64.dmg');
    expect(opened).toEqual([path]);
    expect(Buffer.compare(await readFile(path), dmg)).toBe(0);
    expect(await readdir(join(dir, 'Downloads'))).toEqual(['pixlad-0.3.0-mac-arm64.dmg']);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
    const numbers = progress.filter((p): p is number => p !== undefined);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
  });

  it('keeps a file that is already in Downloads', async () => {
    respond = (url) =>
      url.startsWith('/download/')
        ? { status: 200, body: dmg }
        : { status: 200, body: release('v0.3.0') };
    await mkdir(join(dir, 'Downloads'));
    await writeFile(join(dir, 'Downloads', 'pixlad-0.3.0-mac-arm64.dmg'), 'mine');
    const source = make();
    await source.check();
    const result = await source.download(() => undefined);
    expect(result).toMatchObject({ fileName: 'pixlad-0.3.0-mac-arm64 (1).dmg' });
    expect(await readFile(join(dir, 'Downloads', 'pixlad-0.3.0-mac-arm64.dmg'), 'utf8')).toBe(
      'mine',
    );
  });

  it('leaves no partial file when the download fails', async () => {
    respond = (url) =>
      url.startsWith('/download/')
        ? { status: 502, body: 'bad' }
        : { status: 200, body: release('v0.3.0') };
    const source = make();
    await source.check();
    await expect(source.download(() => undefined)).rejects.toThrow('502');
    expect(await readdir(join(dir, 'Downloads')).catch(() => [])).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('says so when the saved file cannot be opened', async () => {
    respond = (url) =>
      url.startsWith('/download/')
        ? { status: 200, body: dmg }
        : { status: 200, body: release('v0.3.0') };
    const source = new GithubDmgSource({
      apiUrl: base,
      currentVersion: '0.2.0',
      arch: 'arm64',
      fetch,
      downloadsDir: join(dir, 'Downloads'),
      openPath: async () => 'no application',
    });
    await source.check();
    await expect(source.download(() => undefined)).rejects.toThrow('could not open it');
  });

  it('needs a check that found something before it downloads', async () => {
    await expect(make().download(() => undefined)).rejects.toThrow('no update');
  });
});
