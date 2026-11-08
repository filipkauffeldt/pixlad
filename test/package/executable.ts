import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'dist');

/** The product name, read from the one place it is set. */
function productName(): string {
  const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  const match = /^productName:\s*(.+?)\s*$/m.exec(config);
  if (!match) throw new Error('productName not found in electron-builder.yml');
  return match[1]!;
}

function packageName(): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }).name;
}

/** Where electron-builder leaves the unpacked app for this OS, next to the installer. */
export function packagedExecutable(): string {
  const candidates: Record<string, string> = {
    darwin: join(dist, 'mac-arm64', `${productName()}.app`, 'Contents', 'MacOS', productName()),
    win32: join(dist, 'win-unpacked', `${productName()}.exe`),
    linux: join(dist, 'linux-unpacked', packageName()),
  };
  const path = candidates[process.platform];
  if (!path) throw new Error(`No packaged app is built for ${process.platform}`);
  if (!existsSync(path)) {
    const found = existsSync(dist) ? readdirSync(dist).join(', ') : 'no dist folder';
    throw new Error(`Packaged app not found at ${path} (dist has: ${found}). Run "pnpm package".`);
  }
  return path;
}

/** The AppImage that electron-builder leaves in dist/ on Linux. */
export function packagedAppImage(): string {
  const names = existsSync(dist) ? readdirSync(dist) : [];
  const name = names.find((file) => file.endsWith('.AppImage'));
  if (!name) {
    throw new Error(`No AppImage in ${dist} (found: ${names.join(', ')}). Run "pnpm package".`);
  }
  return join(dist, name);
}
