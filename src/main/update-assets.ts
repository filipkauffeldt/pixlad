// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { posix } from 'node:path';

/** One file of a GitHub release, as the releases API lists it. */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

/** The installer each system takes, and the names its CPU goes by in the file name. */
const INSTALLERS: Partial<
  Record<NodeJS.Platform, { extension: string; cpus: Record<string, string[]> }>
> = {
  darwin: { extension: '.dmg', cpus: { arm64: ['arm64'] } },
  win32: { extension: '.exe', cpus: { x64: ['x64'] } },
  linux: { extension: '.rpm', cpus: { x64: ['x86_64'] } },
};

/**
 * The installer of a release for this system and CPU. The blockmap and update files that sit
 * beside it never match, because their names do not end in the installer's extension. A system
 * with no installer for its CPU, such as an Intel Mac, gets undefined.
 */
export function chooseInstaller(
  assets: readonly ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | undefined {
  const installer = INSTALLERS[platform];
  const cpuNames = installer?.cpus[arch];
  if (!installer || !cpuNames) return undefined;
  return assets.find(
    (asset) =>
      asset.name.toLowerCase().endsWith(installer.extension) &&
      cpuNames.some((cpu) => asset.name.toLowerCase().includes(cpu)),
  );
}

/** The electron-updater class that updates this install. */
export type UpdaterKind = 'nsis' | 'appimage' | 'rpm';

/**
 * Which updater fits this install. The AppImage runtime sets APPIMAGE to the file it runs and
 * APPDIR to the folder it mounts. Both have to be there, and the app has to run from inside that
 * folder. A variable that an AppImage terminal passes on to an rpm install does not count,
 * because the AppImage updater replaces the file APPIMAGE names.
 */
export function chooseUpdater(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): UpdaterKind {
  if (platform === 'win32') return 'nsis';
  const appImage = env['APPIMAGE'];
  const appDir = env['APPDIR'];
  if (platform === 'linux' && appImage && appDir) {
    const inside = posix.relative(posix.resolve(appDir), posix.resolve(execPath));
    if (inside !== '' && !inside.startsWith('..') && !posix.isAbsolute(inside)) return 'appimage';
  }
  return 'rpm';
}
