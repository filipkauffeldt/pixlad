// Measures what the lossless export changes compared with decoding and re-encoding the whole
// image. Not a pass/fail test: it prints numbers for a photo you have (never committed).
//   MEASURE_PHOTO=/path/to/photo.jpg pnpm vitest run test/measure.test.ts
import { it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { exportEdit } from '../src/main/export-photo';
import { rasterizeRectPixels } from '../src/shared/mask';

async function measure(input: string): Promise<void> {
  const source = await readFile(input);
  const meta = await sharp(source).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const rect = { type: 'rect' as const, x: 0.3, y: 0.25, w: 0.3, h: 0.4 };
  const dir = await mkdtemp(join(tmpdir(), 'pixlad-measure-'));
  const path = join(dir, basename(input));
  await writeFile(path, source);

  const decode = async (jpeg: Buffer): Promise<Buffer> => sharp(jpeg).raw().toBuffer();
  const reference = await decode(source);
  const exported = await exportEdit({
    sourcePath: path,
    op: { blockSizeRel: 32 / Math.max(width, height), areas: [{ shape: rect }] },
  });
  const output = await decode(await readFile(exported.path));

  // Naive route: decode, mosaic nothing, encode again at q95 with the same subsampling.
  const naive = await decode(
    await sharp(reference, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95, chromaSubsampling: '4:2:0' })
      .toBuffer(),
  );

  const mask = rasterizeRectPixels(
    { x: rect.x * width, y: rect.y * height, w: rect.w * width, h: rect.h * height },
    width,
    height,
  );
  const margin = 17; // one 16x16 MCU plus the chroma filter's reach
  const x0 = Math.floor(rect.x * width) - margin;
  const x1 = Math.ceil((rect.x + rect.w) * width) + margin;
  const y0 = Math.floor(rect.y * height) - margin;
  const y1 = Math.ceil((rect.y + rect.h) * height) + margin;

  function stats(
    candidate: Buffer,
    region: (x: number, y: number) => boolean,
  ): { n: number; max: number; mean: number; psnr: number } {
    let n = 0;
    let max = 0;
    let sum = 0;
    let sq = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!region(x, y)) continue;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(
            candidate[(y * width + x) * 3 + c]! - reference[(y * width + x) * 3 + c]!,
          );
          max = Math.max(max, d);
          sum += d;
          sq += d * d;
          n++;
        }
      }
    }
    const mse = sq / n;
    return {
      n: n / 3,
      max,
      mean: sum / n,
      psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    };
  }
  const far = (x: number, y: number): boolean => x < x0 || x >= x1 || y < y0 || y >= y1;
  const nearUnmasked = (x: number, y: number): boolean => !far(x, y) && !mask[y * width + x];
  const format = (s: ReturnType<typeof stats>): string =>
    `${s.n} px, max ${s.max}, mean ${s.mean.toFixed(4)}, PSNR ${Number.isFinite(s.psnr) ? s.psnr.toFixed(1) + ' dB' : 'infinite (identical)'}`;

  console.log(
    `${basename(input)}: ${width}x${height}, source ${source.length} bytes, export ${exported.bytes} bytes, ${exported.blocksRewritten} blocks re-encoded`,
  );
  console.log('lossless, away from the mosaic     :', format(stats(output, far)));
  console.log('lossless, beside the mosaic        :', format(stats(output, nearUnmasked)));
  console.log(
    're-encode everything at q95        :',
    format(stats(naive, (x, y) => !mask[y * width + x])),
  );
  await rm(dir, { recursive: true, force: true });
}

it.skipIf(!process.env['MEASURE_PHOTO'])(
  'prints the measurements',
  async () => {
    for (const photo of process.env['MEASURE_PHOTO']!.split(',')) await measure(photo);
  },
  300_000,
);
