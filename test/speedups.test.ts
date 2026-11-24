import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { experiments } from '../src/main/faces/experiments';
import { dehaze } from '../src/main/faces/people';
import { runYuNet } from '../src/main/faces/yunet';

const model = join(
  resolve(import.meta.dirname, '..'),
  'resources/models/face_detection_yunet_2026may.onnx',
);

/** A gradient with noise on it, so the dehaze tiles each get their own mean and spread. */
function picture(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    for (let k = 0; k < 3; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      rgba[i * 4 + k] = (x * (k + 1) + y * 2 + (seed >>> 24) / 4) & 255;
    }
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

afterEach(() => {
  experiments.dehaze = false;
  experiments.buffers = false;
});

describe('dehaze speedup', () => {
  it.each([
    [1, 1],
    [95, 40],
    [200, 333],
    [700, 450],
  ])('gives the same bytes at %ix%i', (width, height) => {
    const img = { rgba: picture(width, height), width, height };
    const before = dehaze(img).rgba;
    experiments.dehaze = true;
    expect(Buffer.compare(dehaze(img).rgba, before)).toBe(0);
  });
});

describe.skipIf(!existsSync(model))('YuNet buffer speedup', () => {
  it("gives the same output when a smaller tile reuses a bigger tile's array", async () => {
    const width = 1400;
    const height = 900;
    const rgba = picture(width, height);
    const tiles = [
      [0, 0, 640, 640],
      [700, 200, 620, 630],
      [300, 100, 300, 500],
      [100, 250, 640, 640],
      [760, 260, 607, 641],
    ] as const;
    const run = async () => {
      const all = [];
      for (const [x, y, w, h] of tiles) {
        all.push(await runYuNet(model, rgba, width, height, x, y, w, h, 0));
      }
      return all;
    };
    const before = await run();
    experiments.buffers = true;
    expect(await run()).toEqual(before);
    expect(await run()).toEqual(before);
  });
});
