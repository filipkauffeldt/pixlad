// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// electron-builder's beforePack hook. electron-builder skips an extraResources file that does not
// exist, so a missing face model (`pnpm fetch-model` could not download it) would produce a package
// where Faces fails. Stop the build instead.
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'out/main/index.js',
  'out/main/worker.js',
  'out/preload/index.cjs',
  'out/renderer/index.html',
  'build/icon.png',
  'build/icons/512x512.png',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'resources/models/face_detection_yunet_2026may.onnx',
];

export default function checkPackageInputs() {
  const missing = required.filter((file) => {
    const path = join(root, file);
    return !existsSync(path) || statSync(path).size === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Cannot package: missing or empty ${missing.join(', ')}. ` +
        'Run "pnpm fetch-model" for the model and "pnpm build" for out/.',
    );
  }
}
