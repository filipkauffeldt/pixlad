// Generated JPEG fixtures. No photo is committed: everything is built here.
import sharp from 'sharp';

export interface Rgb {
  width: number;
  height: number;
  data: Buffer; // RGB, 3 bytes per pixel
}

/** A synthetic "photo": smooth gradients, a few colour fields, and a fine pattern "face". */
export function syntheticPhoto(width: number, height: number): Rgb {
  const data = Buffer.alloc(width * height * 3);
  const faceX = Math.round(width * 0.5);
  const faceY = Math.round(height * 0.4);
  const faceR = Math.round(Math.min(width, height) * 0.16);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      let r = 40 + (170 * x) / width;
      let g = 60 + (120 * y) / height;
      let b = 200 - (140 * x) / width;
      if (x > width * 0.1 && x < width * 0.3 && y > height * 0.6 && y < height * 0.9) {
        r = 200;
        g = 30;
        b = 40;
      }
      const dx = x - faceX;
      const dy = y - faceY;
      if (dx * dx + dy * dy < faceR * faceR) {
        // Fine stripes and a ring: detail far smaller than the mosaic block.
        const stripe = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0 ? 235 : 25;
        r = stripe;
        g = stripe * 0.8;
        b = stripe * 0.6;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { width, height, data };
}

export interface JpegOptions {
  quality?: number;
  subsampling?: '4:2:0' | '4:4:4';
  progressive?: boolean;
}

/** Plain JPEG from sharp/libjpeg, with whatever metadata sharp adds stripped back out. */
export async function encodeJpeg(photo: Rgb, options: JpegOptions = {}): Promise<Buffer> {
  const buffer = await sharp(photo.data, { raw: { width: photo.width, height: photo.height, channels: 3 } })
    .jpeg({
      quality: options.quality ?? 90,
      chromaSubsampling: options.subsampling ?? '4:2:0',
      progressive: options.progressive ?? false,
      mozjpeg: false,
    })
    .toBuffer();
  return withSegments(buffer, []);
}

export interface RawSegment {
  marker: number;
  payload: Buffer;
}

/** The JPEG with all APPn/COM segments removed and `segments` inserted after SOI. */
export function withSegments(jpeg: Buffer, segments: RawSegment[], trailing?: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const s of segments) parts.push(segment(s.marker, s.payload));
  let pos = 2;
  while (pos < jpeg.length) {
    const marker = jpeg[pos + 1]!;
    if (jpeg[pos] !== 0xff) throw new Error('bad fixture');
    if (marker === 0xda) {
      parts.push(jpeg.subarray(pos));
      break;
    }
    const length = jpeg.readUInt16BE(pos + 2);
    const isMeta = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMeta) parts.push(jpeg.subarray(pos, pos + 2 + length));
    pos += 2 + length;
  }
  if (trailing) parts.push(trailing);
  return Buffer.concat(parts);
}

export function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Decode to raw RGB with no colour handling: the values the file stores. */
export async function decodeRaw(jpeg: Buffer): Promise<Rgb> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
  return { width: info.width, height: info.height, data };
}

// ------------------------------------------------------------------------------------ ICC

const s15 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(v * 65536));
  return b;
};

/** A minimal Adobe RGB (1998) matrix/TRC profile, built here so no profile file is committed. */
export function adobeRgbProfile(): Buffer {
  const tag = (type: string, body: Buffer): Buffer => {
    const b = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.alloc(4), body]);
    return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  };
  const xyz = (x: number, y: number, z: number): Buffer => tag('XYZ ', Buffer.concat([s15(x), s15(y), s15(z)]));
  const gamma = Buffer.alloc(8);
  gamma.writeUInt32BE(1, 0);
  gamma.writeUInt16BE(Math.round(2.19921875 * 256), 4);
  const curv = tag('curv', gamma.subarray(0, 6));
  const text = (s: string): Buffer => tag('text', Buffer.from(`${s}\0`, 'latin1'));
  const descText = Buffer.from('Adobe RGB (1998) test\0', 'latin1');
  const desc = tag(
    'desc',
    Buffer.concat([
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(descText.length);
        return b;
      })(),
      descText,
      Buffer.alloc(4 + 4 + 2 + 1 + 67),
    ]),
  );
  const tags: Array<[string, Buffer]> = [
    ['desc', desc],
    ['cprt', text('generated for tests')],
    ['wtpt', xyz(0.9505, 1.0, 1.089)],
    ['rXYZ', xyz(0.60974, 0.31111, 0.01947)],
    ['gXYZ', xyz(0.20528, 0.62567, 0.06087)],
    ['bXYZ', xyz(0.14919, 0.06322, 0.74457)],
    ['rTRC', curv],
    ['gTRC', curv],
    ['bTRC', curv],
  ];
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const table = Buffer.alloc(tableSize);
  table.writeUInt32BE(tags.length, 0);
  const bodies: Buffer[] = [];
  tags.forEach(([sig, body], i) => {
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(offset, 8 + i * 12);
    table.writeUInt32BE(body.length, 12 + i * 12);
    offset += body.length;
    bodies.push(body);
  });
  const header = Buffer.alloc(128);
  header.writeUInt32BE(offset, 0);
  header.writeUInt32BE(0x02100000, 8);
  header.write('mntr', 12, 'latin1');
  header.write('RGB ', 16, 'latin1');
  header.write('XYZ ', 20, 'latin1');
  header.write('acsp', 36, 'latin1');
  s15(0.9642).copy(header, 68);
  s15(1.0).copy(header, 72);
  s15(0.8249).copy(header, 76);
  return Buffer.concat([header, table, ...bodies]);
}

export function iccSegments(profile: Buffer): RawSegment[] {
  const max = 65519 - 14;
  const chunks: Buffer[] = [];
  for (let at = 0; at < profile.length; at += max) chunks.push(profile.subarray(at, at + max));
  return chunks.map((chunk, i) => ({
    marker: 0xe2,
    payload: Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([i + 1, chunks.length]), chunk]),
  }));
}

// ----------------------------------------------------------------------------------- EXIF

export interface ExifOptions {
  orientation?: number;
  /** A JPEG to embed as the IFD1 thumbnail. */
  thumbnail?: Buffer;
  dateTimeOriginal?: string;
  /** Embed a preview JPEG in a maker-note-like blob. */
  makerNotePreview?: Buffer;
}

export function exifSegment(options: ExifOptions = {}): RawSegment {
  const le = true;
  const w16 = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    le ? b.writeUInt16LE(v) : b.writeUInt16BE(v);
    return b;
  };
  const w32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    le ? b.writeUInt32LE(v) : b.writeUInt32BE(v);
    return b;
  };
  const entry = (tag: number, type: number, count: number, value: Buffer): Buffer =>
    Buffer.concat([w16(tag), w16(type), w32(count), Buffer.concat([value, Buffer.alloc(4)]).subarray(0, 4)]);
  const date = Buffer.from(`${options.dateTimeOriginal ?? '2024:06:01 12:34:56'}\0`, 'latin1');
  const make = Buffer.from('FixtureCam\0', 'latin1');
  const maker = options.makerNotePreview
    ? Buffer.concat([Buffer.from('FIXTURE\0', 'latin1'), options.makerNotePreview])
    : undefined;

  // Layout: header(8) IFD0 | make | ExifIFD | date | maker | IFD1 | thumbnail
  const ifd0Count = 4;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifCount = maker ? 2 : 1;
  const exifSize = 2 + exifCount * 12 + 4;
  const makeAt = 8 + ifd0Size;
  const exifAt = makeAt + make.length;
  const dateAt = exifAt + exifSize;
  const makerAt = dateAt + date.length;
  const ifd1At = makerAt + (maker?.length ?? 0);
  const ifd1Size = 2 + 2 * 12 + 4;
  const thumbAt = ifd1At + ifd1Size;

  const ifd0 = Buffer.concat([
    w16(ifd0Count),
    entry(0x010f, 2, make.length, w32(makeAt)),
    entry(0x0112, 3, 1, w16(options.orientation ?? 1)),
    entry(0x0131, 2, 1, Buffer.from('x\0', 'latin1')),
    entry(0x8769, 4, 1, w32(exifAt)),
    w32(options.thumbnail ? ifd1At : 0),
  ]);
  const exif = Buffer.concat([
    w16(exifCount),
    entry(0x9003, 2, date.length, w32(dateAt)),
    ...(maker ? [entry(0x927c, 7, maker.length, w32(makerAt))] : []),
    w32(0),
  ]);
  const parts = [Buffer.from('II*\0', 'latin1'), w32(8), ifd0, make, exif, date];
  if (maker) parts.push(maker);
  if (options.thumbnail) {
    parts.push(
      Buffer.concat([
        w16(2),
        entry(0x0201, 4, 1, w32(thumbAt)),
        entry(0x0202, 4, 1, w32(options.thumbnail.length)),
        w32(0),
      ]),
      options.thumbnail,
    );
  }
  return { marker: 0xe1, payload: Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), ...parts]) };
}

// --------------------------------------------------------------------- IPTC, XMP, MPF, JFIF

export function iptcSegment(options: { photoshopThumbnail?: Buffer } = {}): RawSegment {
  const record = (dataset: number, text: string): Buffer => {
    const data = Buffer.from(text, 'utf8');
    const head = Buffer.from([0x1c, 2, dataset, data.length >> 8, data.length & 255]);
    return Buffer.concat([head, data]);
  };
  const iptc = Buffer.concat([
    record(5, 'Fixture object name'),
    record(25, 'fixture-keyword'),
    record(120, 'Caption written for the mosaic tests'),
  ]);
  const resource = (id: number, data: Buffer): Buffer => {
    const head = Buffer.alloc(6);
    head.write('8BIM', 0, 'latin1');
    head.writeUInt16BE(id, 4);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    return Buffer.concat([head, Buffer.from([0, 0]), size, data, Buffer.alloc(data.length % 2)]);
  };
  const parts = [Buffer.from('Photoshop 3.0\0', 'latin1'), resource(0x0404, iptc)];
  if (options.photoshopThumbnail) {
    const header = Buffer.alloc(28);
    header.writeUInt32BE(1, 0);
    parts.push(resource(0x040c, Buffer.concat([header, options.photoshopThumbnail])));
  }
  return { marker: 0xed, payload: Buffer.concat(parts) };
}

export function xmpSegment(options: { thumbnail?: Buffer } = {}): RawSegment {
  const thumb = options.thumbnail
    ? `<xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmpGImg:format>JPEG</xmpGImg:format><xmpGImg:width>8</xmpGImg:width><xmpGImg:height>8</xmpGImg:height><xmpGImg:image>${options.thumbnail.toString('base64')}</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails>`
    : '';
  const packet = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/" xmp:CreateDate="2024-06-01T12:34:56"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Fixture title</rdf:li></rdf:Alt></dc:title>${thumb}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return {
    marker: 0xe1,
    payload: Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(packet, 'utf8')]),
  };
}

export const mpfSegment = (): RawSegment => ({
  marker: 0xe2,
  payload: Buffer.concat([Buffer.from('MPF\0', 'latin1'), Buffer.alloc(60, 1)]),
});

export function jfifSegment(thumbnail = false): RawSegment {
  const payload = Buffer.alloc(thumbnail ? 14 + 12 : 14);
  payload.write('JFIF\0', 0, 'latin1');
  payload.writeUInt16BE(0x0102, 5);
  payload[7] = 1;
  payload.writeUInt16BE(72, 8);
  payload.writeUInt16BE(72, 10);
  if (thumbnail) {
    payload[12] = 2;
    payload[13] = 2;
  }
  return { marker: 0xe0, payload };
}
