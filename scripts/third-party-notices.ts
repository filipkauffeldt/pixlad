// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
//
// Writes THIRD_PARTY_NOTICES.txt: the licence text of every production dependency (the code that
// ships with the app) and of the other third-party parts listed below. `--check` fails instead of
// writing when the file is out of date, when a dependency has a licence that is not known to be
// GPL-compatible, or when no licence text can be found for one.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'THIRD_PARTY_NOTICES.txt');

/** Licences that may be combined with GPL-3.0-or-later. Anything else needs a human decision. */
const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'OFL-1.1',
  '(MIT OR CC0-1.0)',
]);

/** Packages whose npm tarball has no licence file: the text is kept in third_party/. */
const LICENSE_OVERRIDES: Record<string, string> = {
  'onnxruntime-node': 'third_party/onnxruntime/LICENSE',
  'onnxruntime-common': 'third_party/onnxruntime/LICENSE',
};

/** Parts that are not npm production dependencies. */
const EXTRA: Array<{ title: string; note: string; files: string[] }> = [
  {
    title: 'ONNX Runtime native library (third-party components)',
    note: 'Notices for the components built into the ONNX Runtime library that onnxruntime-node loads.',
    files: ['third_party/onnxruntime/ThirdPartyNotices.txt'],
  },
  {
    title: 'YuNet face detection model (MIT)',
    note: 'face_detection_yunet_2026may.onnx from the OpenCV Zoo, downloaded at install.',
    files: ['third_party/yunet/LICENSE'],
  },
  {
    title: 'Independent JPEG Group',
    note: 'This software is based in part on the work of the Independent JPEG Group.',
    files: [],
  },
  {
    title: 'Electron and Chromium (MIT and others)',
    note:
      'The app runs on Electron. Its licence and the licences of Chromium and its components ship ' +
      'with the Electron runtime as LICENSE and LICENSES.chromium.html.',
    files: [],
  },
];

interface Package {
  name: string;
  version: string;
  license: string;
  homepage: string | undefined;
  dir: string;
}

interface Manifest {
  name: string;
  version: string;
  license?: unknown;
  homepage?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;

/** Node's lookup: `node_modules/<name>` in the package's real folder or any folder above it. */
function findPackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

function productionPackages(): Package[] {
  const found = new Map<string, Package>();
  const visit = (dir: string, optional: Set<string>): void => {
    const manifest = readManifest(dir);
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(deps)) {
      const depDir = findPackage(name, dir);
      if (!depDir) {
        // An optional dependency for another platform is simply not installed.
        if (optional.has(name)) continue;
        throw new Error(`${name} (needed by ${manifest.name}) is not installed`);
      }
      if (found.has(depDir)) continue;
      const dep = readManifest(depDir);
      if (typeof dep.license !== 'string') {
        throw new Error(`${dep.name}@${dep.version} has no SPDX licence in package.json`);
      }
      found.set(depDir, {
        name: dep.name,
        version: dep.version,
        license: dep.license,
        homepage: dep.homepage,
        dir: depDir,
      });
      visit(depDir, new Set(Object.keys(dep.optionalDependencies ?? {})));
    }
  };
  visit(root, new Set(Object.keys(readManifest(root).optionalDependencies ?? {})));
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

const RULE = '='.repeat(79);

/** The About dialog splits the file at RULE lines, so no licence text may contain one. */
function readText(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').trimEnd();
  if (text.split('\n').includes(RULE)) throw new Error(`${path} contains a section rule line`);
  return text;
}

function licenseText(pkg: Package): string {
  const override = LICENSE_OVERRIDES[pkg.name];
  if (override) return readText(join(root, override));
  const file = readdirSync(pkg.dir).find((entry) => /^(licen[cs]e|copying)(\.|-|$)/i.test(entry));
  if (!file) throw new Error(`${pkg.name}@${pkg.version} has no licence file`);
  return readText(join(pkg.dir, file));
}

function render(): string {
  const rule = RULE;
  const parts = [
    'Third-party notices for Pixlad',
    '',
    'Pixlad is Copyright (C) 2026 Filip Kauffeldt and licensed under the GNU General',
    'Public License, version 3 or later (see LICENSE). It includes the third-party software',
    'below, each under its own licence.',
    '',
    'Generated by scripts/third-party-notices.ts (pnpm notices). Do not edit by hand.',
  ];
  const problems: string[] = [];
  for (const pkg of productionPackages()) {
    if (!ALLOWED.has(pkg.license)) problems.push(`${pkg.name}@${pkg.version}: ${pkg.license}`);
    parts.push(
      '',
      rule,
      `${pkg.name} ${pkg.version} (${pkg.license})`,
      ...(pkg.homepage ? [pkg.homepage] : []),
      rule,
      '',
      licenseText(pkg),
    );
  }
  if (problems.length > 0) {
    throw new Error(`Licences that are not on the GPL-compatible list:\n${problems.join('\n')}`);
  }
  for (const extra of EXTRA) {
    parts.push('', rule, extra.title, rule, '', extra.note);
    for (const file of extra.files) parts.push('', readText(join(root, file)));
  }
  return `${parts.join('\n')}\n`;
}

const text = render();
if (process.argv.includes('--check')) {
  const current = existsSync(output) ? readFileSync(output, 'utf8').replace(/\r\n?/g, '\n') : '';
  if (current !== text) {
    console.error('THIRD_PARTY_NOTICES.txt is out of date. Run `pnpm notices` and commit it.');
    process.exit(1);
  }
} else {
  writeFileSync(output, text);
}
