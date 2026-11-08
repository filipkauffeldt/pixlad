// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt

/** A semantic version as `X.Y.Z` with an optional `-prerelease` part. Build metadata is dropped. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const NUMBER = '0|[1-9]\\d*';
const IDENTIFIER = `(?:${NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = new RegExp(
  `^v?(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z.-]+)?$`,
);

/** Reads `1.2.3`, `v1.2.3` or `1.2.3-rc.1`. Anything else, such as `dev` or `1.2`, is undefined. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export const isPrerelease = (version: Version): boolean => version.prerelease.length > 0;

export const formatVersion = (version: Version): string =>
  `${version.major}.${version.minor}.${version.patch}` +
  (isPrerelease(version) ? `-${version.prerelease.join('.')}` : '');

const isNumeric = (identifier: string): boolean => /^\d+$/.test(identifier);

function comparePrerelease(a: string[], b: string[]): number {
  // A version without a prerelease part comes after the same version with one.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === right) continue;
    if (isNumeric(left) && isNumeric(right)) return Number(left) < Number(right) ? -1 : 1;
    // Numbers come before words, and words compare as text.
    if (isNumeric(left)) return -1;
    if (isNumeric(right)) return 1;
    return left < right ? -1 : 1;
  }
  return a.length - b.length;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when they rank the same. */
export function compareVersions(a: Version, b: Version): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    comparePrerelease(a.prerelease, b.prerelease)
  );
}

/** Whether `candidate` is a release that is newer than `current`. Prereleases never count. */
export function isNewerRelease(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now || isPrerelease(next)) return false;
  return compareVersions(next, now) > 0;
}
