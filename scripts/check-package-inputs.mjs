// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// electron-builder silently skips a missing extraResources file, packaging an app where Faces fails.
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
  'resources/models/deimv2-s-wholebody34.onnx',
  'resources/models/deimv2-n-wholebody34.onnx',
  'resources/models/selfie-multiclass.onnx',
];

export default function checkPackageInputs() {
  const missing = required.filter((file) => {
    const path = join(root, file);
    return !existsSync(path) || statSync(path).size === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Cannot package: missing or empty ${missing.join(', ')}. ` +
        'Run "pnpm fetch-model" for the models and "pnpm build" for out/.',
    );
  }
}
