import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/**
 * A PNG of 8-bit RGBA pixels. With `icc` the profile is embedded (iCCP), so Chromium colour-manages
 * this image exactly like the JPEG it came from: the mosaic preview and the photo under it go
 * through the same profile. Compression level 1: these are previews, speed matters.
 */
export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  icc?: Uint8Array,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
  ];
  if (icc && icc.length > 0) {
    parts.push(chunk('iCCP', Buffer.concat([Buffer.from('icc\0\0', 'latin1'), deflateSync(icc)])));
  }
  parts.push(chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
