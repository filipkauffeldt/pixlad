// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
//
// Times Find all faces and Outlines on one photo, on the CPU and on every GPU execution provider
// this ONNX Runtime build offers here, and prints the timings as tables.
//   pnpm bench:gpu <photo.jpg> [--ep cpu,webgpu] [--runs 3] [--models selfie,yunet]
// A column can switch on speedups under test (src/main/faces/experiments.ts): --ep cpu,cpu+dehaze
//   pnpm bench:gpu --check dml     loads each model on one provider with a few settings
// Each provider runs in its own process, so a driver that crashes takes only its own column down.
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { arch, availableParallelism, cpus, platform, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Box } from '../src/main/faces/people.ts';
import type { Point } from '../src/shared/types.ts';
import { experiments } from '../src/main/faces/experiments.ts';
import type { EpResult, measure, Pass, Step } from './gpu-bench-run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'resources', 'models');
const RESULT = '@@result ';
const PROGRESS = '@@ ';

async function child(ep: string, photo: string, passes: number, only: string[]): Promise<void> {
  const { createServer, createServerModuleRunner } = await import('vite');
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  const bench = await runner.import<{ measure: typeof measure }>(
    join(root, 'scripts', 'gpu-bench-run.ts'),
  );
  const result = await bench.measure(ep, photo, modelsDir, passes, only, (line) =>
    process.stderr.write(`${PROGRESS}${line}\n`),
  );
  process.stdout.write(`${RESULT}${JSON.stringify(result)}\n`, () => process.exit(0));
}

function runProvider(
  ep: string,
  photo: string,
  passes: number,
  only: string[],
): Promise<EpResult | string> {
  return new Promise((done) => {
    const proc = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--child', ep, photo, String(passes), only.join(',')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let pending = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(PROGRESS)) console.error(`  ${ep}: ${line.slice(PROGRESS.length)}`);
        else stderr += `${line}\n`;
      }
    });
    proc.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT));
      if (line) return done(JSON.parse(line.slice(RESULT.length)) as EpResult);
      const lines = stderr.trim().split(/\r?\n/);
      const reason = (lines.find((l) => /^\s*\w*Error:/.test(l)) ?? lines.at(-1))?.trim();
      done(`exited with code ${code}${reason ? `: ${reason}` : ''}`);
    });
  });
}

function gpuNames(): string {
  try {
    const run = (cmd: string, args: string[]): string =>
      execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
    const os = platform();
    if (os === 'linux') {
      return run('lspci', [])
        .split('\n')
        .filter((l) => /VGA|3D|Display/.test(l))
        .map((l) => l.replace(/^\S+\s+[^:]+:\s*/, ''))
        .join('; ');
    }
    if (os === 'darwin') {
      return run('system_profiler', ['SPDisplaysDataType'])
        .split('\n')
        .filter((l) => l.includes('Chipset Model:'))
        .map((l) => l.split(':')[1]!.trim())
        .join('; ');
    }
    if (os === 'win32') {
      return run('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_VideoController).Name',
      ])
        .trim()
        .split(/\r?\n/)
        .join('; ');
    }
  } catch {
    // Not every system has the tool; the GPU stays unnamed.
  }
  return 'unknown';
}

/** On Linux the GPU is only reachable for members of the render group. */
function linuxGpuBlocked(): boolean {
  if (platform() !== 'linux') return false;
  try {
    const nodes = readdirSync('/dev/dri').filter((n) => n.startsWith('renderD'));
    return (
      nodes.length > 0 &&
      !nodes.some((n) => {
        try {
          accessSync(`/dev/dri/${n}`, constants.R_OK | constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })
    );
  } catch {
    return false;
  }
}

const seconds = (ms: number): string =>
  ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`;

function versus(ms: number, cpu: number | undefined): string {
  if (cpu === undefined || ms === cpu) return '';
  const ratio = cpu / ms;
  return ratio >= 1 ? ` (${ratio.toFixed(1)}× faster)` : ` (${(1 / ratio).toFixed(1)}× slower)`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join(' | ')} |`;
  const rule = `|${widths.map((w, i) => (i === 0 ? '-'.repeat(w + 2) : `${'-'.repeat(w + 1)}:`)).join('|')}|`;
  return [line(headers), rule, ...rows.map(line)].join('\n');
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
};

function iou(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
}

/** How many of `boxes` have a box of `reference` over them (IoU 0.5 or more), each used once. */
function matching(boxes: Box[], reference: Box[]): number {
  const used = new Set<number>();
  let n = 0;
  for (const box of boxes) {
    const k = reference.findIndex((r, i) => !used.has(i) && iou(box, r) >= 0.5);
    if (k >= 0) {
      used.add(k);
      n++;
    }
  }
  return n;
}

/**
 * How far the outlines `r` traced lie from the CPU's, for the people both found in the same place:
 * the largest and the median distance between matching outline points.
 */
function outlineShift(r: EpResult, cpu: EpResult): string {
  const worst: number[] = [];
  r.found.outlines.forEach((outline, i) => {
    const reference = cpu.found.outlines[i];
    const box = r.found.people[i];
    const cpuBox = cpu.found.people[i];
    if (!outline || !reference || !box || !cpuBox || iou(box, cpuBox) < 0.9) return;
    if (outline.length !== reference.length) return worst.push(Infinity);
    worst.push(
      Math.max(
        ...outline.map((p: Point, k) => Math.hypot(p.x - reference[k]!.x, p.y - reference[k]!.y)),
      ),
    );
  });
  if (worst.length === 0) return 'none to compare';
  return `${Math.max(...worst).toFixed(1)} px (median ${median(worst).toFixed(1)} px, ${worst.length} outlines)`;
}

const STEP_NAMES: Record<Step, string> = {
  findFaces: 'Find all faces',
  findPeople: 'Outlines: find people',
  trace: 'Outlines: trace',
};

function report(photo: string, results: Map<string, EpResult | string>, only: string[]): void {
  const eps = [...results.keys()];
  const ok = [...results.values()].filter((r): r is EpResult => typeof r !== 'string');
  const cpu = ok.find((r) => r.ep === 'cpu');
  const first = cpu ?? ok[0];
  const ort = JSON.parse(
    readFileSync(join(root, 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8'),
  ) as { version: string };

  console.log('');
  if (first) {
    const mp = (first.width * first.height) / 1e6;
    console.log(
      `Photo: ${basename(photo)}, ${first.width}×${first.height} (${mp.toFixed(1)} MP), decoded in ${seconds(first.openMs)}`,
    );
  }
  console.log(
    `Machine: ${platform()} ${arch()}, ${cpus()[0]?.model.trim() ?? 'unknown CPU'} (${availableParallelism()} threads), ${Math.round(totalmem() / 2 ** 30)} GB`,
  );
  console.log(`GPU: ${gpuNames()}`);
  console.log(`ONNX Runtime ${ort.version}, Node ${process.versions.node}`);
  if (linuxGpuBlocked()) {
    console.log(
      'Note: you are not in the render group, so WebGPU ran on a software renderer, not the GPU.',
    );
  }
  if (only.length > 0) {
    console.log(
      `Only models matching ${only.join(', ')} ran on the GPU providers; the rest on the CPU.`,
    );
  }
  for (const [ep, r] of results) {
    if (typeof r === 'string') console.log(`${ep} failed: ${r}`);
    else if (r.onCpu.length > 0) {
      console.log(`${ep} could not load ${r.onCpu.join(', ')}; those ran on the CPU.`);
    }
  }
  if (ok.length === 0) return;

  const cell = (r: EpResult | string, pick: (r: EpResult) => number, base?: number): string =>
    typeof r === 'string' ? 'failed' : `${seconds(pick(r))}${versus(pick(r), base)}`;
  const warm = (r: EpResult, s: Step, part: 'ms' | 'modelMs'): number =>
    median(r.warm.map((p) => p.steps[s][part]));
  const total = (p: Pass): number => Object.values(p.steps).reduce((sum, s) => sum + s.ms, 0);

  const rows: string[][] = [];
  for (const s of Object.keys(STEP_NAMES) as Step[]) {
    for (const part of ['ms', 'modelMs'] as const) {
      const base = cpu && warm(cpu, s, part);
      rows.push([
        part === 'ms' ? STEP_NAMES[s] : '  in the models',
        ...eps.map((ep) => cell(results.get(ep)!, (r) => warm(r, s, part), base)),
      ]);
    }
  }
  const cpuAll = cpu && median(cpu.warm.map(total));
  rows.push([
    'All three steps',
    ...eps.map((ep) => cell(results.get(ep)!, (r) => median(r.warm.map(total)), cpuAll)),
  ]);
  const cpuCold = cpu && total(cpu.cold);
  rows.push([
    'All three, first run',
    ...eps.map((ep) => cell(results.get(ep)!, (r) => total(r.cold), cpuCold)),
  ]);
  console.log(
    `\nWhole photo, median of ${first!.warm.length} run${first!.warm.length === 1 ? '' : 's'} after the first\n`,
  );
  console.log(table(['Step', ...eps], rows));

  const models = Object.keys(first!.models);
  console.log('\nEach model on its own, median time per run\n');
  console.log(
    table(
      ['Model', 'Input', 'Runs, all three steps', ...eps],
      models.map((m) => [
        m,
        first!.models[m]!.input,
        String(first!.warm[0]?.runs[m] ?? 0),
        ...eps.map((ep) => cell(results.get(ep)!, (r) => r.models[m]!.ms, cpu?.models[m]!.ms)),
      ]),
    ),
  );

  if (!cpu) return;
  const found = (r: EpResult | string, pick: (r: EpResult) => Box[]): string =>
    typeof r === 'string'
      ? 'failed'
      : r === cpu
        ? String(pick(r).length)
        : `${pick(r).length} (${matching(pick(r), pick(cpu))} same as CPU)`;
  console.log('\nWhat each provider found\n');
  console.log(
    table(
      ['Result', ...eps],
      [
        [
          'Faces (Find all faces)',
          ...eps.map((ep) => found(results.get(ep)!, (r) => r.found.faces)),
        ],
        ['People (Outlines)', ...eps.map((ep) => found(results.get(ep)!, (r) => r.found.people))],
        [
          'Outline shape, largest shift from CPU',
          ...eps.map((ep) => {
            const r = results.get(ep)!;
            return typeof r === 'string' ? 'failed' : r === cpu ? '' : outlineShift(r, cpu);
          }),
        ],
        [
          'Outlines traced',
          ...eps.map((ep) => {
            const r = results.get(ep)!;
            return typeof r === 'string' ? 'failed' : String(r.found.traced);
          }),
        ],
      ],
    ),
  );
}

const CHECK_MODELS: { name: string; file: string; input: string; dims: number[] }[] = [
  {
    name: 'YuNet',
    file: 'face_detection_yunet_2026may.onnx',
    input: 'input',
    dims: [1, 3, 640, 640],
  },
  { name: 'DEIMv2-N', file: 'deimv2-n-wholebody34.onnx', input: 'images', dims: [1, 3, 640, 640] },
  { name: 'DEIMv2-S', file: 'deimv2-s-wholebody34.onnx', input: 'images', dims: [1, 3, 640, 640] },
  { name: 'Selfie segmenter', file: 'selfie-multiclass.onnx', input: '', dims: [1, 256, 256, 3] },
];

const CHECK_SETTINGS = {
  'as benchmarked': {
    graphOptimizationLevel: 'all',
    enableMemPattern: false,
    executionMode: 'sequential',
  },
  'basic optimizations': {
    graphOptimizationLevel: 'basic',
    enableMemPattern: false,
    executionMode: 'sequential',
  },
  'no optimizations': {
    graphOptimizationLevel: 'disabled',
    enableMemPattern: false,
    executionMode: 'sequential',
  },
  'ONNX Runtime defaults': {},
} as const;
type CheckSetting = keyof typeof CHECK_SETTINGS;

async function checkOne(ep: string, model: string, setting: CheckSetting): Promise<void> {
  const ort = await import('onnxruntime-node');
  const spec = CHECK_MODELS.find((m) => m.name === model)!;
  let outcome: string;
  try {
    const session = await ort.InferenceSession.create(join(modelsDir, spec.file), {
      ...CHECK_SETTINGS[setting],
      executionProviders: [ep],
      logSeverityLevel: 3,
    });
    const data = new Float32Array(spec.dims.reduce((a, b) => a * b));
    const input = new ort.Tensor('float32', data, spec.dims);
    const start = performance.now();
    await session.run({ [spec.input || session.inputNames[0]!]: input });
    outcome = `ok, first run ${seconds(performance.now() - start)}`;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    outcome = message
      .replace(/^.*tid\([0-9a-f]+\)\s*/is, '')
      .split(/\r?\n/)[0]!
      .slice(0, 60);
  }
  process.stdout.write(`${RESULT}${outcome}\n`, () => process.exit(0));
}

/** Each model and setting in its own process, so one failure cannot spoil the next. */
async function check(ep: string): Promise<void> {
  const settings = Object.keys(CHECK_SETTINGS) as CheckSetting[];
  const rows: string[][] = [];
  for (const model of CHECK_MODELS) {
    const row = [model.name];
    for (const setting of settings) {
      console.error(`  ${ep}: ${model.name}, ${setting}`);
      const outcome = await new Promise<string>((done) => {
        const proc = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), '--check-one', ep, model.name, setting],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
        let stdout = '';
        proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        proc.on('close', (code) => {
          const line = stdout.split('\n').find((l) => l.startsWith(RESULT));
          done(line ? line.slice(RESULT.length) : `crashed (exit code ${code})`);
        });
      });
      row.push(outcome);
    }
    rows.push(row);
  }
  console.log(`\nLoading each model on ${ep} and running it once\n`);
  console.log(table(['Model', ...settings], rows));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--child') {
    return child(args[1]!, args[2]!, Number(args[3]), args[4] ? args[4].split(',') : []);
  }
  if (args[0] === '--check-one') return checkOne(args[1]!, args[2]!, args[3] as CheckSetting);
  if (args[0] === '--check') return check(args[1] ?? 'dml');

  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const value = args[at + 1];
    args.splice(at, 2);
    return value;
  };
  const epOption = option('--ep');
  const passes = Number(option('--runs') ?? 3);
  // PowerShell hands an unquoted `cpu,dml` over as `cpu dml`.
  const list = (value: string | undefined): string[] =>
    (value ?? '').split(/[\s,]+/).filter(Boolean);
  const only = list(option('--models')).map((m) => m.toLowerCase());
  const photo = args[0] && resolve(args[0]);
  if (!photo || !existsSync(photo) || !Number.isInteger(passes) || passes < 1) {
    console.error(
      'Usage: pnpm bench:gpu <photo.jpg> [--ep cpu,webgpu] [--runs 3] [--models selfie], or pnpm bench:gpu --check dml',
    );
    process.exit(1);
  }
  if (!existsSync(join(modelsDir, 'deimv2-s-wholebody34.onnx'))) {
    console.error('The models are missing. Run "pnpm fetch-model".');
    process.exit(1);
  }

  const { listSupportedBackends } = await import('onnxruntime-node');
  const available = listSupportedBackends();
  const eps = epOption
    ? list(epOption)
    : ['cpu', ...available.filter((b) => b.bundled && b.name !== 'cpu').map((b) => b.name)];
  const unknown = eps.flatMap((column) => {
    const [ep = '', ...tries] = column.split('+');
    return [
      ...(available.some((b) => b.name === ep) ? [] : [ep]),
      ...tries.filter((t) => !(t in experiments)),
    ];
  });
  if (unknown.length > 0) {
    console.error(
      `Unknown: ${unknown.join(', ')}. Providers: ${available.map((b) => b.name).join(', ')}. Speedups: ${Object.keys(experiments).join(', ')}.`,
    );
    process.exit(1);
  }
  console.error(
    `Providers in this build: ${available.map((b) => b.name + (b.bundled ? '' : ' (not bundled)')).join(', ')}`,
  );
  console.error(`Benchmarking ${eps.join(', ')} on ${basename(photo)}, ${passes} runs each`);

  const results = new Map<string, EpResult | string>();
  for (const ep of eps) results.set(ep, await runProvider(ep, photo, passes, only));
  report(photo, results, only);
}

await main();
