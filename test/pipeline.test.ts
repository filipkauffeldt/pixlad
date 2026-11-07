import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportEdit } from '../src/main/export-photo';
import { decodeCoefficients } from '../src/main/jpeg/decode';
import { planesToRgba, decodePlanes } from '../src/main/jpeg/pixels';
import type { MosaicOp } from '../src/shared/types';
import { decodeRaw, encodeJpeg, syntheticPhoto } from './helpers/fixtures';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixlad-pipeline-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('own decoder', () => {
  it('matches libjpeg-turbo within rounding for baseline 4:2:0, 4:4:4 and progressive', async () => {
    const photo = syntheticPhoto(200, 150);
    for (const options of [
      { subsampling: '4:2:0' as const },
      { subsampling: '4:4:4' as const },
      { subsampling: '4:2:0' as const, progressive: true },
    ]) {
      const jpeg = await encodeJpeg(photo, options);
      const reference = await decodeRaw(jpeg);
      const decoded = decodeCoefficients(jpeg);
      const rgba = planesToRgba(decoded, decodePlanes(decoded));
      let sum = 0;
      for (let i = 0; i < reference.width * reference.height; i++) {
        for (let c = 0; c < 3; c++) sum += Math.abs(rgba[i * 4 + c]! - reference.data[i * 3 + c]!);
      }
      const mean = sum / (reference.width * reference.height * 3);
      // Different chroma upsampling (replicate vs fancy) and IDCT rounding.
      expect(mean).toBeLessThan(2.5);
    }
  });
});

describe('export', () => {
  it('writes a mosaic edit next to the source', async () => {
    const photo = syntheticPhoto(320, 240);
    const jpeg = await encodeJpeg(photo, { quality: 95 });
    const source = join(dir, 'a.jpg');
    await writeFile(source, jpeg);
    const op: MosaicOp = {
      blockSizeRel: 24 / 320,
      areas: [{ shape: { type: 'rect', x: 0.3, y: 0.2, w: 0.4, h: 0.5 } }],
    };
    const result = await exportEdit({ sourcePath: source, op });
    expect(result.path).toBe(join(dir, 'a_edit.jpg'));
    expect(Buffer.compare(await readFile(source), jpeg)).toBe(0);
    const out = await decodeRaw(await readFile(result.path));
    const src = await decodeRaw(jpeg);
    // far from the mosaic: identical
    let diff = 0;
    for (let x = 0; x < 40; x++)
      for (let y = 0; y < 240; y++)
        diff += Math.abs(out.data[(y * 320 + x) * 3]! - src.data[(y * 320 + x) * 3]!);
    expect(diff).toBe(0);
    expect(Math.abs((await stat(result.path)).mtimeMs - (await stat(source)).mtimeMs)).toBeLessThan(
      1,
    );
  });
});
