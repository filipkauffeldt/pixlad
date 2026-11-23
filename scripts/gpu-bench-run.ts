// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
//
// The measuring half of gpu-bench.ts: runs Find all faces and Outlines on one photo with every
// model session forced onto one ONNX Runtime execution provider. Loaded through Vite, since the
// app's modules import each other without file extensions.
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as ort from 'onnxruntime-node';
import type { Rect } from '../src/shared/types';
import { detectFaces } from '../src/main/faces/detect';
import { OUTLINE_MODELS, outlineModel } from '../src/main/faces/models';
import { traceOutlines, type TraceItem } from '../src/main/faces/outlines';
import { findPeople, type Box, type Person } from '../src/main/faces/people';
import { decodeCoefficients } from '../src/main/jpeg/decode';
import { decodePlanes, planesToRgba } from '../src/main/jpeg/pixels';

const YUNET = 'face_detection_yunet_2026may.onnx';

export const MODEL_NAMES: Record<string, string> = {
  [YUNET]: 'YuNet',
  [OUTLINE_MODELS.smallHeads]: 'DEIMv2-N',
  [OUTLINE_MODELS.heads]: 'DEIMv2-S',
  [OUTLINE_MODELS.segmenter]: 'Selfie segmenter',
};

export const STEPS = ['findFaces', 'findPeople', 'trace'] as const;
export type Step = (typeof STEPS)[number];

export interface Pass {
  steps: Record<Step, { ms: number; modelMs: number }>;
  /** Model runs in the whole pass, by model name. */
  runs: Record<string, number>;
}

export interface EpResult {
  ep: string;
  width: number;
  height: number;
  openMs: number;
  cold: Pass;
  warm: Pass[];
  found: { faces: Box[]; people: Box[]; traced: number };
  /** Median milliseconds per run of each model on its own. */
  models: Record<string, { input: string; ms: number }>;
}

const usage = new Map<string, { ms: number; runs: number }>();
const opened: ort.InferenceSession[] = [];

function providerOptions(ep: string): ort.InferenceSession.SessionOptions {
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: [ep],
    logSeverityLevel: 3,
  };
  // DirectML supports neither memory patterns nor parallel execution.
  return ep === 'dml'
    ? { ...options, enableMemPattern: false, executionMode: 'sequential' }
    : options;
}

function timeRuns(session: ort.InferenceSession, name: string): void {
  const run = session.run.bind(session);
  Object.assign(session, {
    run: async (...args: Parameters<typeof run>) => {
      const start = performance.now();
      try {
        return await run(...args);
      } finally {
        const entry = usage.get(name) ?? { ms: 0, runs: 0 };
        entry.ms += performance.now() - start;
        entry.runs++;
        usage.set(name, entry);
      }
    },
  });
}

function useProvider(ep: string): void {
  const create = ort.InferenceSession.create.bind(ort.InferenceSession);
  Object.assign(ort.InferenceSession, {
    create: async (path: string, options?: ort.InferenceSession.SessionOptions) => {
      const session = await create(path, { ...options, ...providerOptions(ep) });
      timeRuns(session, MODEL_NAMES[basename(path)] ?? basename(path));
      opened.push(session);
      return session;
    },
  });
}

async function step<T>(job: () => Promise<T>): Promise<{ value: T; ms: number; modelMs: number }> {
  const before = [...usage.values()].reduce((sum, u) => sum + u.ms, 0);
  const start = performance.now();
  const value = await job();
  const ms = performance.now() - start;
  const after = [...usage.values()].reduce((sum, u) => sum + u.ms, 0);
  return { value, ms, modelMs: after - before };
}

function traceItem(person: Person): TraceItem {
  const [eye, otherEye] = person.landmarks;
  return {
    box: person.box,
    kind: person.kind,
    angle: eye && otherEye ? Math.atan2(otherEye.y - eye.y, otherEye.x - eye.x) : 0,
    confirmed: person.confirmed === true || person.kind !== 'head',
    ...(person.eyes ? { eyes: person.eyes } : {}),
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
};

async function timeAlone(run: () => Promise<unknown>, times = 15): Promise<number> {
  for (let i = 0; i < 3; i++) await run();
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

function randomTensor(dims: number[]): ort.Tensor {
  const data = new Float32Array(dims.reduce((a, b) => a * b));
  for (let i = 0; i < data.length; i++) data[i] = Math.random();
  return new ort.Tensor('float32', data, dims);
}

export async function measure(
  ep: string,
  photoPath: string,
  modelsDir: string,
  passes: number,
  progress: (line: string) => void,
): Promise<EpResult> {
  ort.env.logLevel = 'error';
  useProvider(ep);

  const openStart = performance.now();
  const decoded = decodeCoefficients(await readFile(photoPath));
  const rgba = planesToRgba(decoded, decodePlanes(decoded));
  const openMs = performance.now() - openStart;
  const swap = decoded.header.orientation >= 5;
  const { width: frameWidth, height: frameHeight } = decoded.header.frame;
  const img = {
    rgba,
    width: swap ? frameHeight : frameWidth,
    height: swap ? frameWidth : frameHeight,
  };
  const whole: Rect = { type: 'rect', x: 0, y: 0, w: 1, h: 1 };
  const yunetPath = join(modelsDir, YUNET);

  const all: Pass[] = [];
  let found: EpResult['found'] = { faces: [], people: [], traced: 0 };
  for (let pass = 0; pass <= passes; pass++) {
    progress(pass === 0 ? 'first run (loads the models)' : `run ${pass} of ${passes}`);
    usage.clear();
    const faces = await step(() =>
      detectFaces(img.rgba, img.width, img.height, whole, { modelPath: yunetPath }),
    );
    const people = await step(() => findPeople(img, whole, modelsDir));
    const traced = await step(() => traceOutlines(img, people.value.map(traceItem), modelsDir));
    all.push({
      steps: {
        findFaces: { ms: faces.ms, modelMs: faces.modelMs },
        findPeople: { ms: people.ms, modelMs: people.modelMs },
        trace: { ms: traced.ms, modelMs: traced.modelMs },
      },
      runs: Object.fromEntries([...usage].map(([name, u]) => [name, u.runs])),
    });
    found = {
      faces: faces.value.map((f) => ({
        x: f.box.x * img.width,
        y: f.box.y * img.height,
        w: f.box.w * img.width,
        h: f.box.h * img.height,
      })),
      people: people.value.map((p) => p.box),
      traced: traced.value.filter((o) => o !== undefined).length,
    };
  }

  progress('each model on its own');
  const yunet = await ort.InferenceSession.create(yunetPath, { graphOptimizationLevel: 'all' });
  const heads = await outlineModel(modelsDir, 'heads');
  const smallHeads = await outlineModel(modelsDir, 'smallHeads');
  const segmenter = await outlineModel(modelsDir, 'segmenter');
  const detr = randomTensor([1, 3, 640, 640]);
  const selfie = randomTensor([1, 256, 256, 3]);
  const models: EpResult['models'] = {
    YuNet: { input: '640×640', ms: await timeAlone(() => yunet.run({ input: detr })) },
    'DEIMv2-N': { input: '640×640', ms: await timeAlone(() => smallHeads.run({ images: detr })) },
    'DEIMv2-S': { input: '640×640', ms: await timeAlone(() => heads.run({ images: detr }), 5) },
    'Selfie segmenter': {
      input: '256×256',
      ms: await timeAlone(() => segmenter.run({ [segmenter.inputNames[0]!]: selfie })),
    },
  };

  await Promise.all(opened.map((s) => s.release()));
  return {
    ep,
    width: img.width,
    height: img.height,
    openMs,
    cold: all[0]!,
    warm: all.slice(1),
    found,
    models,
  };
}
