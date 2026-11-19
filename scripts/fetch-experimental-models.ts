// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// EXPERIMENTAL, dev only: fetches the models behind the detector/outline picker into
// resources/models/experimental/. Not shipped. The MediaPipe models are TFLite and are converted to
// ONNX with tf2onnx through `uv` (https://docs.astral.sh/uv/), which must be installed.
//
//   YOLOv8n/s-face      lindevs/yolov8-face (repo MIT; trained from Ultralytics weights, AGPL-3.0)
//   DEIMv2 Wholebody34  PINTO0309/PINTO_model_zoo 472 (Apache-2.0); streamed out of a 2.5 GB tarball
//   Face landmarks      MediaPipe face_landmarker (Apache-2.0)
//   Selfie multiclass   MediaPipe image segmenter (Apache-2.0)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'resources', 'models', 'experimental');
await mkdir(dir, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'pixlad-models-'));
const have = (name: string): boolean => existsSync(join(dir, name));

async function download(url: string, target: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await writeFile(`${target}.part`, new Uint8Array(await response.arrayBuffer()));
  await rename(`${target}.part`, target);
}

/** Stream a .tar.gz and keep the wanted members, stopping as soon as all are in. */
async function fromTarball(url: string, wanted: Record<string, string>): Promise<void> {
  const left = new Map(Object.entries(wanted));
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const gunzip = Readable.fromWeb(response.body as never).pipe(createGunzip());
  let buffer = Buffer.alloc(0);
  let member: { name: string; size: number; chunks: Buffer[]; got: number } | undefined;
  let skip = 0;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (skip > 0) {
          const n = Math.min(skip, buffer.length);
          if (member) {
            member.chunks.push(buffer.subarray(0, Math.min(n, member.size - member.got)));
            member.got += Math.min(n, member.size - member.got);
          }
          buffer = buffer.subarray(n);
          skip -= n;
          if (skip > 0) break;
          if (member) {
            const target = left.get(member.name)!;
            await writeFile(join(dir, target), Buffer.concat(member.chunks));
            console.log(`Fetched ${target}`);
            left.delete(member.name);
            member = undefined;
            if (left.size === 0) return;
          }
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        if (!name) continue;
        const size =
          parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, ''), 8) || 0;
        const base = name.split('/').pop()!;
        member = left.has(base) ? { name: base, size, chunks: [], got: 0 } : undefined;
        skip = Math.ceil(size / 512) * 512;
        if (skip === 0 && member) member = undefined;
      }
    }
    throw new Error(`not in the tarball: ${[...left.keys()].join(', ')}`);
  } finally {
    controller.abort();
  }
}

function tflite2onnx(source: string, target: string): void {
  execFileSync(
    'uv',
    [
      'run',
      '--no-project',
      '--python',
      '3.11',
      '--with',
      'tf2onnx',
      '--with',
      'tensorflow-cpu==2.15.1',
      '--with',
      'numpy<2',
      '--with',
      'onnx==1.16.2',
      'python',
      '-m',
      'tf2onnx.convert',
      '--tflite',
      source,
      '--output',
      join(dir, target),
      '--opset',
      '13',
    ],
    { stdio: 'inherit' },
  );
  console.log(`Converted ${target}`);
}

try {
  for (const size of ['n', 's']) {
    const name = `yolov8${size}-face.onnx`;
    if (have(name)) continue;
    await download(
      `https://github.com/lindevs/yolov8-face/releases/download/1.0.1/yolov8${size}-face-lindevs.onnx`,
      join(dir, name),
    );
    console.log(`Fetched ${name}`);
  }

  const deim: Record<string, string> = {};
  if (!have('deimv2-n-wholebody34.onnx'))
    deim['deimv2_hgnetv2_n_wholebody34_680query_640x640_nopre.onnx'] = 'deimv2-n-wholebody34.onnx';
  if (!have('deimv2-s-wholebody34.onnx'))
    deim['deimv2_dinov3_s_wholebody34_1750query_640x640_nopre.onnx'] = 'deimv2-s-wholebody34.onnx';
  if (Object.keys(deim).length > 0) {
    console.log('Streaming the DEIMv2 tarball (stops once both models are in, a few minutes)…');
    await fromTarball(
      'https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/472_DEIMv2-Wholebody34/resources.tar.gz',
      deim,
    );
  }

  if (!have('face-landmarks.onnx')) {
    const task = join(temp, 'face_landmarker.task');
    await download(
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
      task,
    );
    // The .task file is a zip; the landmark model is one member.
    execFileSync('python3', [
      '-I',
      '-c',
      'import sys,zipfile; open(sys.argv[2],"wb").write(zipfile.ZipFile(sys.argv[1]).read("face_landmarks_detector.tflite"))',
      task,
      join(temp, 'face_landmarks_detector.tflite'),
    ]);
    tflite2onnx(join(temp, 'face_landmarks_detector.tflite'), 'face-landmarks.onnx');
  }

  if (!have('selfie-multiclass.onnx')) {
    const source = join(temp, 'selfie_multiclass.tflite');
    await download(
      'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
      source,
    );
    tflite2onnx(source, 'selfie-multiclass.onnx');
  }
  console.log('Experimental models are in resources/models/experimental/.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
