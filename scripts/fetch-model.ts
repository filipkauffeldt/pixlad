// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// Downloads the face models into resources/models/ after checking their SHA-256: YuNet (MIT) for
// Faces, and the DEIMv2 detectors and the MediaPipe segmenter (Apache-2.0) for face outlines. The
// models are not committed. Runs after `pnpm install`; run `pnpm fetch-model` to retry.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

interface Model {
  name: string;
  sha256: string;
  /** Where to download it, when that is not a release of the models repository. */
  url?: string;
}

// https://github.com/filipkauffeldt/pixlad-models, which also holds how the files were made.
const MODELS_REPO = 'filipkauffeldt/pixlad-models';
const MODELS_TAG = 'v1';

const MODELS: Model[] = [
  {
    name: 'face_detection_yunet_2026may.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx',
    sha256: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
  },
  {
    name: 'deimv2-s-wholebody34.onnx',
    sha256: 'ec0b4ac5a171615076e76f70f44f95f1f1adfe3d823d0574c5ba813abfe02e17',
  },
  {
    name: 'deimv2-n-wholebody34.onnx',
    sha256: '5854666f0048caa3b9995043247a554dfe6ad2d3017eddfeed8ec90a748fbf9b',
  },
  {
    name: 'selfie-multiclass.onnx',
    sha256: '4a6ddf1f1fe825dcd4bb8c27f57c55f8029e4a75f9006d874cbb353996f2a5b3',
  },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** A GitHub token from the environment, or the one the `gh` CLI holds. */
async function githubToken(): Promise<string | undefined> {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await promisify(execFile)('gh', ['auth', 'token'], { timeout: 5000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined; // gh is not installed or not logged in
  }
}

async function ok(response: Response, what: string): Promise<Response> {
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);
  return response;
}

/** A file of the models repository's release. With a token this goes through the GitHub API, which also works while the repository is private. */
async function fromRelease(name: string): Promise<Uint8Array> {
  const token = await githubToken();
  if (!token) {
    const url = `https://github.com/${MODELS_REPO}/releases/download/${MODELS_TAG}/${name}`;
    return new Uint8Array(await (await ok(await fetch(url), url)).arrayBuffer());
  }
  const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const api = `https://api.github.com/repos/${MODELS_REPO}/releases/tags/${MODELS_TAG}`;
  const release = (await (
    await ok(
      await fetch(api, { headers: { ...headers, Accept: 'application/vnd.github+json' } }),
      api,
    )
  ).json()) as { assets: Array<{ name: string; url: string }> };
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`${name} is not in release ${MODELS_TAG} of ${MODELS_REPO}`);
  const response = await fetch(asset.url, {
    headers: { ...headers, Accept: 'application/octet-stream' },
  });
  return new Uint8Array(await (await ok(response, asset.url)).arrayBuffer());
}

async function fetchModel({ name, url, sha256 }: Model): Promise<void> {
  const target = join(root, 'resources', 'models', name);
  try {
    if (sha(await readFile(target)) === sha256) return;
  } catch {
    // not there yet
  }
  try {
    const data = url
      ? new Uint8Array(await (await ok(await fetch(url), url)).arrayBuffer())
      : await fromRelease(name);
    if (sha(data) !== sha256) throw new Error('checksum mismatch, refusing to use the download');
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.part`;
    await writeFile(temp, data);
    await rename(temp, target);
    console.log(`Fetched ${name}`);
  } catch (cause) {
    await rm(`${target}.part`, { force: true });
    // Do not fail the install: everything but the faces and their outlines works without them.
    console.warn(`Could not fetch ${name} (${String(cause)}). Run "pnpm fetch-model" later.`);
  }
}

for (const model of MODELS) await fetchModel(model);
