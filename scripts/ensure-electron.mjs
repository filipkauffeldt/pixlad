// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Electron's install script is blocked (pnpm-workspace.yaml); resolving the package fetches the binary.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const executable = createRequire(import.meta.url)('electron');
if (typeof executable !== 'string' || !existsSync(executable)) {
  console.error('The Electron binary is not available. Check the network and try again.');
  process.exit(1);
}
