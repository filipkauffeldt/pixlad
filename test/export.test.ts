import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExifTool } from 'exiftool-vendored';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportEdit, ExportFailure } from '../src/main/export-photo';
import { iccProfile, parseHeader } from '../src/main/jpeg/parse';
import { inspectJpegPreviews } from '../src/main/jpeg/previews';
import { rasterizeRectPixels } from '../src/shared/mask';
import type { MosaicOp } from '../src/shared/types';
import {
  adobeRgbProfile,
  decodeStoredRgb,
  encodeJpeg,
  exifSegment,
  iccSegments,
  iptcSegment,
  jfifSegment,
  mpfSegment,
  syntheticPhoto,
  withSegments,
  xmpSegment,
  type RawSegment,
  type Rgb,
} from './helpers/fixtures';

const W = 480;
const H = 320;
const BLOCK = 32;
const REWRITTEN_BOUNDARY_TOLERANCE = 40;
const RECT = { type: 'rect' as const, x: 0.35, y: 0.2, w: 0.3, h: 0.5 };
const op: MosaicOp = { blockSizeRel: BLOCK / W, areas: [{ shape: RECT }] };
const permissionsApply = process.platform !== 'win32' && process.getuid?.() !== 0;

let dir: string;
let exiftool: ExifTool;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixlad-export-'));
  exiftool = new ExifTool({ maxProcs: 1 });
});
afterAll(async () => {
  await exiftool.end();
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function write(jpeg: Buffer, name = `photo-${++counter}.jpg`): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, jpeg);
  return path;
}

function mosaicMaskAndRing(
  width: number,
  height: number,
): { mask: Uint8Array; nearMask: (x: number, y: number) => boolean } {
  const mask = rasterizeRectPixels(
    { x: RECT.x * width, y: RECT.y * height, w: RECT.w * width, h: RECT.h * height },
    width,
    height,
  );
  const x0 = Math.floor(RECT.x * width) - 17;
  const x1 = Math.ceil((RECT.x + RECT.w) * width) + 17;
  const y0 = Math.floor(RECT.y * height) - 17;
  const y1 = Math.ceil((RECT.y + RECT.h) * height) + 17;
  return { mask, nearMask: (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1 };
}

function compare(
  a: Rgb,
  b: Rgb,
  region: (x: number, y: number) => boolean,
): { max: number; n: number } {
  let max = 0;
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (!region(x, y)) continue;
      n++;
      for (let c = 0; c < 3; c++) {
        max = Math.max(
          max,
          Math.abs(a.data[(y * a.width + x) * 3 + c]! - b.data[(y * a.width + x) * 3 + c]!),
        );
      }
    }
  }
  return { max, n };
}

const channelRange = (image: Rgb, x0: number, y0: number, size: number): number => {
  let lo = 255;
  let hi = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const v = image.data[(y * image.width + x) * 3 + 1]!;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return hi - lo;
};

for (const [label, profile] of [
  ['sRGB (no profile)', undefined],
  ['Adobe RGB (tagged)', adobeRgbProfile()],
] as const) {
  for (const subsampling of ['4:2:0', '4:4:4'] as const) {
    describe(`${label}, ${subsampling}`, () => {
      it('leaves pixels outside the mosaic identical and flattens the mosaic blocks', async () => {
        const base = await encodeJpeg(syntheticPhoto(W, H), { quality: 92, subsampling });
        const jpeg = withSegments(base, profile ? iccSegments(profile) : []);
        const path = await write(jpeg);
        const result = await exportEdit({ sourcePath: path, op });
        const written = await readFile(result.path);

        const before = await decodeStoredRgb(jpeg);
        const after = await decodeStoredRgb(written);
        const { mask, nearMask } = mosaicMaskAndRing(W, H);
        // Exact equality is intentional: untouched blocks keep their coefficients.
        expect(compare(before, after, (x, y) => !nearMask(x, y)).max).toBe(0);
        expect(
          compare(before, after, (x, y) => nearMask(x, y) && !mask[y * W + x]).max,
        ).toBeLessThanOrEqual(REWRITTEN_BOUNDARY_TOLERANCE);

        const bx = Math.ceil((RECT.x * W) / BLOCK) * BLOCK;
        const by = Math.ceil((RECT.y * H) / BLOCK) * BLOCK;
        expect(channelRange(before, bx, by, BLOCK)).toBeGreaterThan(60);
        expect(channelRange(after, bx, by, BLOCK)).toBeLessThanOrEqual(6);
        let sum = 0;
        for (let y = by; y < by + BLOCK; y++)
          for (let x = bx; x < bx + BLOCK; x++) sum += before.data[(y * W + x) * 3 + 1]!;
        const mean = sum / (BLOCK * BLOCK);
        expect(Math.abs(after.data[((by + 5) * W + bx + 5) * 3 + 1]! - mean)).toBeLessThanOrEqual(
          4,
        );
      });
    });
  }
}

describe('the ICC profile and metadata', () => {
  const profile = adobeRgbProfile();
  const thumbnail = (): Promise<Buffer> => encodeJpeg(syntheticPhoto(40, 30), { quality: 50 });

  async function richSource(options: {
    orientation?: number;
    withPreviews: boolean;
  }): Promise<Buffer> {
    const thumb = await thumbnail();
    const segments: RawSegment[] = [
      jfifSegment(options.withPreviews),
      exifSegment({
        ...(options.orientation === undefined ? {} : { orientation: options.orientation }),
        dateTimeOriginal: '2023:05:17 09:08:07',
        ...(options.withPreviews ? { ifd1Thumbnail: thumb, makerNotePreview: thumb } : {}),
      }),
      xmpSegment(options.withPreviews ? { thumbnail: thumb } : {}),
      ...iccSegments(profile),
      iptcSegment(options.withPreviews ? { photoshopThumbnail: thumb } : {}),
      ...(options.withPreviews ? [mpfSegment()] : []),
    ];
    const base = await encodeJpeg(syntheticPhoto(W, H), { quality: 90 });
    // An MPF file carries a second full image after the first one's EOI.
    return withSegments(base, segments, options.withPreviews ? await thumbnail() : undefined);
  }

  it('keeps the ICC profile byte for byte', async () => {
    const jpeg = await richSource({ withPreviews: false });
    const result = await exportEdit({ sourcePath: await write(jpeg), op });
    const out = parseHeader(await readFile(result.path));
    expect(Buffer.compare(iccProfile(out.segments)!, profile)).toBe(0);
  });

  it('keeps EXIF, IPTC and XMP and the capture time', async () => {
    const jpeg = await richSource({ orientation: 1, withPreviews: false });
    const source = await write(jpeg);
    const result = await exportEdit({ sourcePath: source, op });
    const a = await exiftool.read(source);
    const b = await exiftool.read(result.path);
    for (const key of [
      'Make',
      'DateTimeOriginal',
      'ObjectName',
      'Keywords',
      'Caption-Abstract',
      'Title',
      'CreateDate',
      'ProfileDescription',
    ] as const) {
      expect(String((b as Record<string, unknown>)[key])).toBe(
        String((a as Record<string, unknown>)[key]),
      );
      expect((b as Record<string, unknown>)[key]).toBeDefined();
    }
    expect(String(b.DateTimeOriginal)).toContain('2023');
  });

  it('removes every thumbnail and preview, also from a source that has them', async () => {
    const jpeg = await richSource({ withPreviews: true });
    const source = await write(jpeg);
    expect(inspectJpegPreviews(jpeg).length).toBeGreaterThan(0);
    const sourceTags = await exiftool.read(source);
    expect(
      sourceTags.ThumbnailImage ?? sourceTags.ThumbnailOffset ?? sourceTags.PhotoshopThumbnail,
    ).toBeDefined();

    const result = await exportEdit({ sourcePath: source, op });
    const written = await readFile(result.path);
    expect(inspectJpegPreviews(written)).toEqual([]);
    const tags = (await exiftool.read(result.path)) as Record<string, unknown>;
    for (const key of [
      'ThumbnailImage',
      'ThumbnailOffset',
      'ThumbnailLength',
      'PreviewImage',
      'PhotoshopThumbnail',
      'MPImage2',
      'JFIFThumbnail',
      'Thumbnails',
    ]) {
      expect(tags[key], key).toBeUndefined();
    }
    const secondJpegStart = written.indexOf(Buffer.from([0xff, 0xd8, 0xff]), 2);
    expect(secondJpegStart).toBe(-1);
    const finalMarker = written.subarray(-2);
    expect(finalMarker).toEqual(Buffer.from([0xff, 0xd9]));
    expect(result.removed.length).toBeGreaterThan(0);
    expect(String(tags.ObjectName)).toBe('Fixture object name');
  });

  for (const orientation of [6, 8]) {
    it(`keeps orientation ${orientation} and puts the mosaic on the upright picture`, async () => {
      const storedLandscape = syntheticPhoto(W, H);
      const base = await encodeJpeg(storedLandscape, { quality: 92 });
      const jpeg = withSegments(base, [exifSegment({ orientation }), ...iccSegments(profile)]);
      const source = await write(jpeg);
      const uprightTopLeftQuarter = { type: 'rect' as const, x: 0, y: 0, w: 0.5, h: 0.5 };
      const result = await exportEdit({
        sourcePath: source,
        op: { blockSizeRel: BLOCK / W, areas: [{ shape: uprightTopLeftQuarter }] },
      });
      const tags = await exiftool.read(result.path);
      expect(tags.Orientation).toBe(orientation);

      const before = await decodeStoredRgb(jpeg);
      const after = await decodeStoredRgb(await readFile(result.path));
      // EXIF 6 is stored rotated 90° CW (quarter at bottom-left), 8 by 270° (top-right).
      const inQuarter = (x: number, y: number): boolean =>
        orientation === 6 ? x < W / 2 && y >= H / 2 : x >= W / 2 && y < H / 2;
      const far = (x: number, y: number): boolean => {
        const dx = orientation === 6 ? Math.max(0, x - W / 2) : Math.max(0, W / 2 - x);
        const dy = orientation === 6 ? Math.max(0, H / 2 - y) : Math.max(0, y - H / 2);
        return dx > 17 || dy > 17;
      };
      expect(compare(before, after, far).max).toBe(0);
      expect(compare(before, after, inQuarter).max).toBeGreaterThan(10);
    });
  }
});

describe('the source file and the target', () => {
  it('never changes the source bytes or modification time, never overwrites an old edit, and replaces its own file on a repeat export', async () => {
    const jpeg = await encodeJpeg(syntheticPhoto(W, H));
    const path = await write(jpeg, 'keep.JPG');
    const old = new Date('2020-01-02T03:04:05Z');
    await utimes(path, old, old);
    await writeFile(join(dir, 'keep_edit.JPG'), 'an edit from an earlier session');

    const result = await exportEdit({ sourcePath: path, op });
    expect(result.path).toBe(join(dir, 'keep_edit-2.JPG'));
    expect(await readFile(join(dir, 'keep_edit.JPG'), 'utf8')).toBe(
      'an edit from an earlier session',
    );
    expect(Buffer.compare(await readFile(path), jpeg)).toBe(0);
    expect((await stat(path)).mtime.toISOString()).toBe(old.toISOString());
    expect(Math.abs((await stat(result.path)).mtimeMs - old.getTime())).toBeLessThan(2);

    const again = await exportEdit({ sourcePath: path, op, written: result.written });
    expect(again.path).toBe(result.path);
    expect(again.replaced).toBe(true);
    expect((await readdir(dir)).filter((n) => n.startsWith('keep'))).toEqual(
      expect.arrayContaining(['keep.JPG', 'keep_edit.JPG', 'keep_edit-2.JPG']),
    );
    expect((await readdir(dir)).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('overwrites the source when asked: mosaic in place, same time, nothing else written', async () => {
    const { mkdir } = await import('node:fs/promises');
    const folder = join(dir, 'overwrite');
    await mkdir(folder);
    const jpeg = await encodeJpeg(syntheticPhoto(W, H));
    const path = join(folder, 'over.JPG');
    await writeFile(path, jpeg);
    const old = new Date('2020-01-02T03:04:05Z');
    await utimes(path, old, old);

    const result = await exportEdit({ sourcePath: path, op, target: 'overwrite' });

    expect(result.path).toBe(path);
    expect(await readdir(folder)).toEqual(['over.JPG']);
    const written = await readFile(path);
    expect(Buffer.compare(written, jpeg)).not.toBe(0);
    expect(inspectJpegPreviews(written)).toEqual([]);
    expect(Math.abs((await stat(path)).mtimeMs - old.getTime())).toBeLessThan(2);
    const before = await decodeStoredRgb(jpeg);
    const after = await decodeStoredRgb(written);
    const x = Math.floor(((RECT.x + RECT.w / 2) * W) / BLOCK) * BLOCK;
    const y = Math.floor(((RECT.y + RECT.h / 2) * H) / BLOCK) * BLOCK;
    expect(channelRange(before, x + 8, y + 8, 16)).toBeGreaterThan(
      channelRange(after, x + 8, y + 8, 16),
    );
  });

  it('refuses to overwrite a read-only source and leaves it alone', async () => {
    if (!permissionsApply) return;
    const { chmod, mkdir } = await import('node:fs/promises');
    const folder = join(dir, 'readonly-file');
    await mkdir(folder);
    const jpeg = await encodeJpeg(syntheticPhoto(W, H));
    const path = join(folder, 'locked.jpg');
    await writeFile(path, jpeg);
    await chmod(path, 0o444);
    await expect(exportEdit({ sourcePath: path, op, target: 'overwrite' })).rejects.toThrow(
      'locked.jpg: cannot overwrite a read-only file',
    );
    expect(Buffer.compare(await readFile(path), jpeg)).toBe(0);
    expect(await readdir(folder)).toEqual(['locked.jpg']);
  });

  it('leaves the source as it was when overwriting fails in the folder', async () => {
    if (!permissionsApply) return;
    const { chmod, mkdir } = await import('node:fs/promises');
    const folder = join(dir, 'readonly-folder');
    await mkdir(folder);
    const jpeg = await encodeJpeg(syntheticPhoto(W, H));
    const path = join(folder, 'a.jpg');
    await writeFile(path, jpeg);
    await chmod(folder, 0o555);
    try {
      await expect(exportEdit({ sourcePath: path, op, target: 'overwrite' })).rejects.toThrow(
        folder,
      );
      expect(Buffer.compare(await readFile(path), jpeg)).toBe(0);
      expect(await readdir(folder)).toEqual(['a.jpg']);
    } finally {
      await chmod(folder, 0o755);
    }
  });

  it('fails per photo, naming the folder, when the folder cannot be written', async () => {
    if (!permissionsApply) return;
    const { chmod, mkdir } = await import('node:fs/promises');
    const folder = join(dir, 'readonly');
    await mkdir(folder);
    const path = join(folder, 'a.jpg');
    await writeFile(path, await encodeJpeg(syntheticPhoto(W, H)));
    await chmod(folder, 0o555);
    try {
      await expect(exportEdit({ sourcePath: path, op })).rejects.toThrow(folder);
      await expect(exportEdit({ sourcePath: path, op })).rejects.toBeInstanceOf(ExportFailure);
      expect(await readdir(folder)).toEqual(['a.jpg']);
    } finally {
      await chmod(folder, 0o755);
    }
  });
});
