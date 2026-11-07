import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../src/main/session';
import { encodeJpeg, syntheticPhoto } from './helpers/fixtures';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mr-session-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = (): Promise<Buffer> =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
    .png()
    .toBuffer();

describe('adding files to a session', () => {
  it('refuses non-JPEG files by their bytes and names them', async () => {
    await writeFile(join(dir, 'picture.png'), await png());
    await writeFile(join(dir, 'disguised.jpg'), await png()); // a PNG with a .jpg name
    await writeFile(join(dir, 'ok.jpg'), await encodeJpeg(syntheticPhoto(64, 48)));
    const result = await new Session().add([
      join(dir, 'picture.png'),
      join(dir, 'disguised.jpg'),
      join(dir, 'ok.jpg'),
    ]);
    expect(result.photos.map((p) => p.name)).toEqual(['ok.jpg']);
    expect(result.refused).toEqual([
      { name: 'picture.png', reason: 'is not a JPEG file' },
      { name: 'disguised.jpg', reason: 'is not a JPEG file' },
    ]);
  });

  it('refuses a CMYK JPEG with a clear reason', async () => {
    const photo = syntheticPhoto(64, 48);
    const cmyk = await sharp(photo.data, { raw: { width: 64, height: 48, channels: 3 } })
      .toColourspace('cmyk')
      .jpeg()
      .toBuffer();
    await writeFile(join(dir, 'print.jpg'), cmyk);
    const result = await new Session().add([join(dir, 'print.jpg')]);
    expect(result.photos).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.name).toBe('print.jpg');
    expect(result.refused[0]!.reason).toContain('CMYK');
  });

  it('reads only headers, reports the upright size and skips duplicates', async () => {
    const jpeg = await encodeJpeg(syntheticPhoto(120, 80));
    await writeFile(join(dir, 'wide.jpg'), jpeg);
    const session = new Session();
    const first = await session.add([join(dir, 'wide.jpg')]);
    expect(first.photos[0]).toMatchObject({ name: 'wide.jpg', width: 120, height: 80 });
    const second = await session.add([join(dir, 'wide.jpg')]);
    expect(second.photos).toEqual([]);
    expect(second.duplicates).toBe(1);
  });

  it('takes the JPEGs directly in a dropped folder, in name order, and says subfolders are not included', async () => {
    const folder = join(dir, 'shoot');
    await mkdir(join(folder, 'nested'), { recursive: true });
    for (const name of ['img10.jpg', 'img2.JPG', 'img1.jpeg']) {
      await writeFile(join(folder, name), await encodeJpeg(syntheticPhoto(32, 24)));
    }
    await writeFile(join(folder, 'notes.txt'), 'not a photo');
    await writeFile(join(folder, 'nested', 'deep.jpg'), await encodeJpeg(syntheticPhoto(32, 24)));
    const result = await new Session().add([folder]);
    expect(result.photos.map((p) => p.name)).toEqual(['img1.jpeg', 'img2.JPG', 'img10.jpg']);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.reason).toContain('subfolders');
  });

  it('handles hundreds of files', async () => {
    const folder = join(dir, 'many');
    await mkdir(folder);
    const jpeg = await encodeJpeg(syntheticPhoto(32, 24));
    for (let i = 0; i < 300; i++)
      await writeFile(join(folder, `p${String(i).padStart(3, '0')}.jpg`), jpeg);
    const result = await new Session().add([folder]);
    expect(result.photos).toHaveLength(300);
  });
});
