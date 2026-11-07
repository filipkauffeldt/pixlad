// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Downloads a public-domain group photo (NASA, via Wikimedia Commons) into fixtures/ for the face
// detection tests. Gitignored, never committed. Tests that need it skip when it is missing.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = 'apollo11_crew.jpg';
const URL_ =
  'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/3d/Apollo_11_Crew.jpg/3840px-Apollo_11_Crew.jpg';
const SHA256 = '00fd0dbcc80bf10282c4b4930d8303e21fd75afaf0ad99d7d4003a7f037cef92';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'fixtures', FILE);
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

try {
  if (sha(await readFile(target)) === SHA256) process.exit(0);
} catch {
  // not there yet
}
const response = await fetch(URL_, { headers: { 'User-Agent': 'mosaic-retouch-fixtures/0.1' } });
if (!response.ok) throw new Error(`${URL_}: HTTP ${response.status}`);
const data = new Uint8Array(await response.arrayBuffer());
if (sha(data) !== SHA256) throw new Error('checksum mismatch, refusing to use the download');
await mkdir(dirname(target), { recursive: true });
await writeFile(`${target}.part`, data);
await rename(`${target}.part`, target);
console.log(`Fetched ${FILE} (public domain, NASA)`);
