// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { RELEASES_OWNER, RELEASES_REPO } from '../shared/update';
import { isPrerelease, parseVersion } from '../shared/version';
import { parseTestUpdates, type TestUpdates } from './update-sources';

export type UpdateFeed =
  { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string };

export interface UpdateEnvironment {
  enabled: boolean;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  apiUrl: string;
  feed: UpdateFeed;
  forceDevUpdateConfig: boolean;
}

export interface Machine {
  isPackaged: boolean;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
}

export function releaseEnvironment(machine: Machine): UpdateEnvironment {
  const version = parseVersion(machine.version);
  return {
    enabled: machine.isPackaged && version !== undefined && !isPrerelease(version),
    currentVersion: machine.version,
    platform: machine.platform,
    arch: machine.arch,
    apiUrl: `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}`,
    feed: { provider: 'github', owner: RELEASES_OWNER, repo: RELEASES_REPO },
    forceDevUpdateConfig: false,
  };
}

const MAC_BUILD_ARCH = 'arm64';

export function testEnvironment(test: TestUpdates): UpdateEnvironment {
  return {
    enabled: true,
    currentVersion: test.version,
    platform: test.platform,
    arch: MAC_BUILD_ARCH,
    apiUrl: test.url,
    feed: { provider: 'generic', url: test.url },
    forceDevUpdateConfig: true,
  };
}

export function resolveUpdateEnvironment(
  machine: Machine,
  testUpdates: string | undefined,
): UpdateEnvironment {
  const test = machine.isPackaged ? undefined : parseTestUpdates(testUpdates);
  return test ? testEnvironment(test) : releaseEnvironment(machine);
}
