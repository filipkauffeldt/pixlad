// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { posix } from 'node:path';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

const INSTALLERS: Partial<
  Record<NodeJS.Platform, { extension: string; cpus: Record<string, string[]> }>
> = {
  darwin: { extension: '.dmg', cpus: { arm64: ['arm64'] } },
  win32: { extension: '.exe', cpus: { x64: ['x64'] } },
  linux: { extension: '.rpm', cpus: { x64: ['x86_64'] } },
};

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

export type UpdaterKind = 'nsis' | 'appimage' | 'rpm';

function isInside(directory: string, path: string): boolean {
  const relative = posix.relative(posix.resolve(directory), posix.resolve(path));
  return relative !== '' && !relative.startsWith('..') && !posix.isAbsolute(relative);
}

export function chooseUpdater(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): UpdaterKind {
  if (platform === 'win32') return 'nsis';
  const appImage = env['APPIMAGE'];
  const appDir = env['APPDIR'];
  // APPIMAGE and APPDIR leak from an AppImage terminal into an rpm install, so check execPath too.
  if (platform === 'linux' && appImage && appDir && isInside(appDir, execPath)) return 'appimage';
  return 'rpm';
}
