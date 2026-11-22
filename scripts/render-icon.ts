// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Linux launchers look icons up by size in hicolor; a lone 1024 px PNG would not be found.
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const build = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'build');
const svg = await readFile(join(build, 'icon.svg'));

async function render(size: number, file: string): Promise<void> {
  await sharp(svg, { density: size * 7.2 })
    .resize(size, size)
    .png()
    .toFile(file);
}

await render(1024, join(build, 'icon.png'));

const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512];
await mkdir(join(build, 'icons'), { recursive: true });
for (const size of linuxSizes) await render(size, join(build, 'icons', `${size}x${size}.png`));
