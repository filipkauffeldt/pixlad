import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextVersion } from '../scripts/next-version';
import {
  compareVersions,
  formatVersion,
  isNewerRelease,
  parseVersion,
  type Version,
} from '../src/shared/version';

const v = (text: string): Version => {
  const version = parseVersion(text);
  if (!version) throw new Error(`not a version: ${text}`);
  return version;
};

describe('parseVersion', () => {
  it('reads plain, prefixed and prerelease versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v10.0.7')).toEqual({ major: 10, minor: 0, patch: 7, prerelease: [] });
    expect(parseVersion('0.0.0-dev.12')).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: ['dev', '12'],
    });
    expect(parseVersion('1.0.0+build.5')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
  });

  it.each(['dev', '', '1.2', '1.2.3.4', 'v', '01.2.3', '1.2.3-', '1.2.3-01', 'latest'])(
    'refuses %j',
    (text) => {
      expect(parseVersion(text)).toBeUndefined();
    },
  );

  it('formats a version without the prefix or the build part', () => {
    expect(formatVersion(v('v1.2.3-rc.1+x'))).toBe('1.2.3-rc.1');
  });
});

describe('compareVersions', () => {
  it('orders by number, not by text', () => {
    expect(compareVersions(v('0.10.0'), v('0.9.0'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.0.0'), v('0.99.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.2.10'), v('0.2.9'))).toBeGreaterThan(0);
    expect(compareVersions(v('1.2.3'), v('1.2.3'))).toBe(0);
  });

  it('puts a prerelease before its release and orders the prerelease parts', () => {
    const ascending = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < ascending.length; i++) {
      expect(compareVersions(v(ascending[i - 1]!), v(ascending[i]!))).toBeLessThan(0);
    }
    expect(compareVersions(v('0.0.0-dev.9'), v('0.0.0-dev.10'))).toBeLessThan(0);
  });
});

describe('isNewerRelease', () => {
  it('is true for a higher release', () => {
    expect(isNewerRelease('0.3.0', '0.2.9')).toBe(true);
    expect(isNewerRelease('v0.3.0', '0.3.0-dev.4')).toBe(true);
  });

  it('is false for the same or an older release', () => {
    expect(isNewerRelease('0.3.0', '0.3.0')).toBe(false);
    expect(isNewerRelease('0.2.0', '0.3.0')).toBe(false);
  });

  it('never offers a prerelease', () => {
    expect(isNewerRelease('1.0.0-rc.1', '0.3.0')).toBe(false);
  });

  it('is false when either side is not a version', () => {
    expect(isNewerRelease('latest', '0.3.0')).toBe(false);
    expect(isNewerRelease('0.3.0', 'dev')).toBe(false);
  });
});

describe('nextVersion', () => {
  it('makes 0.1.0 the first release whatever the bump', () => {
    for (const bump of ['patch', 'minor', 'major']) expect(nextVersion([], bump)).toBe('0.1.0');
  });

  it('bumps the part that was asked for and resets the lower ones', () => {
    const tags = ['v0.2.3'];
    expect(nextVersion(tags, 'patch')).toBe('0.2.4');
    expect(nextVersion(tags, 'minor')).toBe('0.3.0');
    expect(nextVersion(tags, 'major')).toBe('1.0.0');
  });

  it('takes the highest version by number, whatever the order of the tags', () => {
    expect(nextVersion(['v0.9.0', 'v0.10.0', 'v0.2.0'], 'patch')).toBe('0.10.1');
  });

  it('ignores tags that are not plain releases', () => {
    const tags = ['nightly', 'v1.0.0-rc.1', 'vNext', 'v2', 'v0.4.0', '1.9.9'];
    expect(nextVersion(tags, 'minor')).toBe('0.5.0');
    expect(nextVersion(['v1.0.0-rc.1', 'nightly'], 'patch')).toBe('0.1.0');
  });

  it('rejects a bump that is not patch, minor or major', () => {
    expect(() => nextVersion(['v0.1.0'], 'huge')).toThrow(/patch, minor or major/);
    expect(() => nextVersion([], '')).toThrow(/patch, minor or major/);
  });
});

describe('scripts/next-version.ts', () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'next-version.ts');
  const run = (cwd: string, bump: string) =>
    spawnSync(process.execPath, [script, bump], { cwd, encoding: 'utf8' });

  it('reads the tags of the repository it runs in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pixlad-next-version-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: dir,
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        });
      git('init', '-q');
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      );
      expect(run(dir, 'minor').stdout).toBe('0.1.0\n');
      git('tag', 'v0.4.2');
      git('tag', 'v0.4.10');
      expect(run(dir, 'minor').stdout).toBe('0.5.0\n');
      const bad = run(dir, 'huge');
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('patch, minor or major');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
