// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
//
// Prints the version of the next release, for example `0.3.0`. The release workflow runs
// `node scripts/next-version.ts <patch|minor|major>`. The latest release is the highest `vX.Y.Z`
// tag. The first release is 0.1.0 whatever the bump.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  compareVersions,
  isPrerelease,
  type Version,
  parseVersion,
} from '../src/shared/version.ts';

export const BUMPS = ['patch', 'minor', 'major'] as const;
export type Bump = (typeof BUMPS)[number];

export const isBump = (value: string): value is Bump =>
  (BUMPS as readonly string[]).includes(value);

/**
 * The next version from the existing tags. Tags that are not plain `vX.Y.Z`, such as `nightly` or
 * `v1.0.0-rc.1`, are ignored.
 */
export function nextVersion(tags: readonly string[], bump: string): string {
  if (!isBump(bump)) throw new Error(`The bump must be patch, minor or major, not "${bump}".`);
  const releases = tags
    .filter((tag) => tag.startsWith('v'))
    .map((tag) => parseVersion(tag))
    .filter((version): version is Version => version !== undefined && !isPrerelease(version))
    .sort(compareVersions);
  const latest = releases.at(-1);
  let next: string;
  if (!latest) next = '0.1.0';
  else if (bump === 'major') next = `${latest.major + 1}.0.0`;
  else if (bump === 'minor') next = `${latest.major}.${latest.minor + 1}.0`;
  else next = `${latest.major}.${latest.minor}.${latest.patch + 1}`;
  return next;
}

function main(): void {
  const bump = process.argv[2] ?? '';
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');
  try {
    console.log(nextVersion(tags, bump));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
