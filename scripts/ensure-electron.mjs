// Install scripts are not allowed to run for Electron (see pnpm-workspace.yaml), and electron-vite
// fails on a missing binary instead of fetching it. Resolving the package downloads it when needed.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const executable = createRequire(import.meta.url)('electron');
if (typeof executable !== 'string' || !existsSync(executable)) {
  console.error('The Electron binary is not available. Check the network and try again.');
  process.exit(1);
}
