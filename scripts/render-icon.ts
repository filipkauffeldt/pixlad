// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
//
// Renders build/icon.svg to build/icon.png (1024 px), which electron-builder turns into the macOS
// and Windows icons. Run `pnpm render-icon` after changing the SVG and commit both files.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const build = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'build');
const svg = await readFile(join(build, 'icon.svg'));
await sharp(svg, { density: 1024 * 7.2 })
  .resize(1024, 1024)
  .png()
  .toFile(join(build, 'icon.png'));
