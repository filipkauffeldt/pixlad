// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Downloads the YuNet face detection model (MIT) into resources/models/ after checking its SHA-256.
// The model is not committed. Runs after `pnpm install`; run `pnpm fetch-model` to retry.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'face_detection_yunet_2026may.onnx';
const URL_ =
  'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx';
const SHA256 = 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'resources', 'models', NAME);
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

try {
  if (sha(await readFile(target)) === SHA256) process.exit(0);
} catch {
  // not there yet
}

try {
  const response = await fetch(URL_);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (sha(data) !== SHA256) throw new Error('checksum mismatch, refusing to use the download');
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.part`;
  await writeFile(temp, data);
  await rename(temp, target);
  console.log(`Fetched ${NAME}`);
} catch (cause) {
  await rm(`${target}.part`, { force: true });
  // Do not fail the install: everything but Faces works without the model.
  console.warn(`Could not fetch the face model (${String(cause)}). Run "pnpm fetch-model" later.`);
}
