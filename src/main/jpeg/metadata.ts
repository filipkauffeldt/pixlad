import type { Segment } from './parse';

/**
 * Metadata for the exported file: everything from the source that is not (or does not hold) a
 * thumbnail or preview, copied byte for byte; the rest is removed or blanked.
 *
 * Kept: JFIF without thumbnail, EXIF (IFD1 thumbnail and preview tags removed, embedded JPEG
 * streams zeroed), XMP (thumbnail properties removed), ICC profile chunks (untouched), Photoshop
 * IRB with IPTC (thumbnail resources removed), Adobe marker, comments.
 * Dropped: MPF and every other APPn segment, and anything after EOI, because none of that can be
 * shown to be free of a preview of the unretouched picture.
 */
export interface ScrubResult {
  segments: Segment[];
  /** What was removed, for the per-photo status line. */
  removed: string[];
}

const latin1 = (b: Uint8Array, from = 0, to = b.length): string =>
  Buffer.from(b.buffer, b.byteOffset + from, to - from).toString('latin1');
const startsWith = (b: Uint8Array, text: string): boolean => latin1(b, 0, text.length) === text;

export function scrubSegments(segments: readonly Segment[]): ScrubResult {
  const kept: Segment[] = [];
  const removed: string[] = [];
  // Extended XMP is split over several segments; decide for all of them together.
  const extended = segments.filter((s) => s.marker === 0xe1 && startsWith(s.payload, XMP_EXT));
  const extendedHasThumbnail =
    extended.length > 0 &&
    /g\/img\/|GImg:image|:Thumbnails/i.test(extended.map((s) => latin1(s.payload)).join(''));

  for (const segment of segments) {
    const { marker, payload } = segment;
    if (marker === 0xfe || (marker >= 0xdb && marker <= 0xdb)) {
      kept.push(segment);
    } else if (marker === 0xe0) {
      if (startsWith(payload, 'JFIF\0') && payload.length >= 14) {
        const clean = payload.slice(0, 14);
        clean[12] = 0;
        clean[13] = 0;
        if (payload.length > 14 || payload[12] || payload[13]) removed.push('JFIF thumbnail');
        kept.push({ marker, payload: clean });
      } else removed.push('APP0 other than JFIF');
    } else if (marker === 0xe1) {
      if (startsWith(payload, 'Exif\0\0')) {
        const result = scrubExif(payload);
        removed.push(...result.removed);
        kept.push({ marker, payload: result.payload });
      } else if (startsWith(payload, XMP_STD)) {
        const head = XMP_STD.length + 1;
        const text = latin1(payload, head);
        const scrubbed = scrubXmp(text);
        if (scrubbed !== text) removed.push('XMP thumbnail');
        kept.push({
          marker,
          payload: Buffer.concat([
            Buffer.from(payload.subarray(0, head)),
            Buffer.from(scrubbed, 'latin1'),
          ]),
        });
      } else if (startsWith(payload, XMP_EXT)) {
        if (extendedHasThumbnail) {
          if (extended[0] === segment) removed.push('extended XMP (held a thumbnail)');
        } else kept.push(segment);
      } else removed.push('unknown APP1');
    } else if (marker === 0xe2) {
      if (startsWith(payload, 'ICC_PROFILE\0')) kept.push(segment);
      else removed.push(startsWith(payload, 'MPF\0') ? 'MPF (multi-picture)' : 'unknown APP2');
    } else if (marker === 0xed) {
      const scrubbed = scrubIrb(payload);
      if (scrubbed) {
        if (scrubbed.removed.length > 0) removed.push(...scrubbed.removed);
        kept.push({ marker, payload: scrubbed.payload });
      } else removed.push('unreadable Photoshop resources');
    } else if (marker === 0xee) {
      if (startsWith(payload, 'Adobe') && payload.length === 12) kept.push(segment);
      else removed.push('unknown APP14');
    } else if (marker >= 0xe0 && marker <= 0xef) {
      removed.push(`APP${marker - 0xe0}`);
    }
  }
  return { segments: kept, removed: [...new Set(removed)] };
}

const XMP_STD = 'http://ns.adobe.com/xap/1.0/';
const XMP_EXT = 'http://ns.adobe.com/xmp/extension/';

/** Remove XMP thumbnail properties and the namespace that declares them. */
export function scrubXmp(text: string): string {
  return text
    .replace(/<(\w+):Thumbnails\b[^>]*>[\s\S]*?<\/\1:Thumbnails>/gi, '')
    .replace(/<(xmpGImg|xapGImg|xmpTNG|xmpTng):(\w+)\b[^>]*>[\s\S]*?<\/\1:\2>/g, '')
    .replace(/\s(xmpGImg|xapGImg|xmpTNG|xmpTng):\w+="[^"]*"/g, '')
    .replace(/\sxmlns:(xmpGImg|xapGImg|xmpTNG|xmpTng)="[^"]*"/g, '');
}

/** Photoshop image resources: drop the thumbnails, scrub embedded XMP, keep IPTC verbatim. */
function scrubIrb(payload: Uint8Array): { payload: Uint8Array; removed: string[] } | undefined {
  const header = 'Photoshop 3.0\0';
  if (!startsWith(payload, header)) return undefined;
  const out: Buffer[] = [Buffer.from(header, 'latin1')];
  const removed: string[] = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let at = header.length;
  while (at < payload.length) {
    if (at + 12 > payload.length || latin1(payload, at, at + 4) !== '8BIM') return undefined;
    const id = view.getUint16(at + 4);
    const nameLength = payload[at + 6]!;
    const nameField = (1 + nameLength) % 2 === 0 ? 1 + nameLength : 2 + nameLength;
    const sizeAt = at + 6 + nameField;
    if (sizeAt + 4 > payload.length) return undefined;
    const size = view.getUint32(sizeAt);
    const dataAt = sizeAt + 4;
    const end = dataAt + size + (size % 2);
    if (dataAt + size > payload.length) return undefined;
    const data = payload.subarray(dataAt, dataAt + size);
    if (id === 0x0409 || id === 0x040c) {
      removed.push('Photoshop thumbnail');
    } else if (id === 0x0424) {
      const scrubbed = Buffer.from(scrubXmp(latin1(data)), 'latin1');
      if (scrubbed.length !== data.length) removed.push('XMP thumbnail');
      out.push(resource(id, payload.subarray(at + 6, sizeAt), scrubbed));
    } else {
      out.push(Buffer.from(payload.subarray(at, Math.min(end, payload.length))));
    }
    at = end;
  }
  return { payload: Buffer.concat(out), removed };
}

function resource(id: number, nameField: Uint8Array, data: Buffer): Buffer {
  const head = Buffer.alloc(6);
  head.write('8BIM', 0, 'latin1');
  head.writeUInt16BE(id, 4);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  return Buffer.concat([head, Buffer.from(nameField), size, data, Buffer.alloc(data.length % 2)]);
}

// ------------------------------------------------------------------------------------- EXIF

const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

/**
 * Take the thumbnail and preview out of an EXIF block: IFD1 is unlinked and blanked together with
 * its image data, preview tags are deleted from every IFD, and any JPEG stream still inside the
 * block (maker notes) is zeroed in place so nothing else changes offsets.
 */
export function scrubExif(payload: Uint8Array): { payload: Uint8Array; removed: string[] } {
  const out = Uint8Array.from(payload);
  const removed: string[] = [];
  const tiff = out.subarray(6);
  const little = tiff[0] === 0x49;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (at: number): number =>
    at >= 0 && at + 2 <= tiff.length ? view.getUint16(at, little) : 0;
  const u32 = (at: number): number =>
    at >= 0 && at + 4 <= tiff.length ? view.getUint32(at, little) : 0;
  const set32 = (at: number, v: number): void => void view.setUint32(at, v, little);
  const set16 = (at: number, v: number): void => void view.setUint16(at, v, little);
  if (tiff.length < 8 || (tiff[0] !== 0x49 && tiff[0] !== 0x4d) || u16(2) !== 42) {
    return { payload: out, removed };
  }
  const zero = (from: number, length: number): void => {
    if (from >= 0 && length > 0 && from + length <= tiff.length) tiff.fill(0, from, from + length);
  };
  const visited = new Set<number>();

  const valueAt = (entry: number): number => {
    const type = u16(entry + 2);
    return type === 3 ? u16(entry + 8) : u32(entry + 8);
  };

  const walkIfd = (offset: number, isThumbnail: boolean): void => {
    if (offset < 8 || visited.has(offset) || visited.size > 64) return;
    visited.add(offset);
    const count = u16(offset);
    if (count > 512 || offset + 2 + count * 12 + 4 > tiff.length) return;
    const entries: Array<{ tag: number; at: number }> = [];
    for (let i = 0; i < count; i++)
      entries.push({ tag: u16(offset + 2 + i * 12), at: offset + 2 + i * 12 });
    const thumbOffset = entries.find((e) => e.tag === 0x201);
    const thumbLength = entries.find((e) => e.tag === 0x202);
    if (thumbOffset && thumbLength) zero(valueAt(thumbOffset.at), valueAt(thumbLength.at));
    const stripOffsets = entries.find((e) => e.tag === 0x111);
    const stripCounts = entries.find((e) => e.tag === 0x117);
    if (
      isThumbnail &&
      stripOffsets &&
      stripCounts &&
      u32(stripOffsets.at + 4) === 1 &&
      u32(stripCounts.at + 4) === 1
    ) {
      zero(valueAt(stripOffsets.at), valueAt(stripCounts.at));
    }
    const doomed = new Set([0x201, 0x202, 0x2e, 0xc51b]);
    const next = u32(offset + 2 + count * 12);
    // Follow the sub-IFD pointers before the table is rewritten.
    for (const e of entries) {
      if (e.tag === 0x8769 || e.tag === 0x8825 || e.tag === 0xa005) walkIfd(u32(e.at + 8), false);
      if (e.tag === 0x14a) {
        const n = u32(e.at + 4);
        const base = n * 4 <= 4 ? e.at + 8 : u32(e.at + 8);
        for (let i = 0; i < Math.min(n, 16); i++) walkIfd(u32(base + i * 4), false);
      }
    }
    for (const e of entries) {
      if (doomed.has(e.tag) && e.tag !== 0x2e && e.tag !== 0xc51b) removed.push('EXIF thumbnail');
      if ((e.tag === 0x2e || e.tag === 0xc51b) && TYPE_SIZE[u16(e.at + 2)] !== undefined) {
        const size = TYPE_SIZE[u16(e.at + 2)]! * u32(e.at + 4);
        if (size > 4) zero(u32(e.at + 8), size);
        removed.push('EXIF preview');
      }
    }
    const kept = entries.filter((e) => !doomed.has(e.tag));
    if (kept.length !== entries.length) {
      const raw = Buffer.from(tiff.subarray(offset + 2, offset + 2 + count * 12));
      const end = offset + 2 + count * 12 + 4;
      tiff.fill(0, offset, end);
      set16(offset, kept.length);
      kept.forEach((e, i) => {
        Buffer.from(raw.subarray(e.at - offset - 2, e.at - offset - 2 + 12)).copy(
          tiff,
          offset + 2 + i * 12,
        );
      });
      set32(offset + 2 + kept.length * 12, next);
    }
    const nextAt = offset + 2 + kept.length * 12;
    if (next !== 0) {
      if (isThumbnail || offset === u32(4)) {
        // IFD1 (the thumbnail IFD): walk it to find its image data, blank it, unlink it.
        const before = visited.size;
        walkIfd(next, true);
        void before;
        const c1 = u16(next);
        if (c1 <= 512 && next + 2 + c1 * 12 + 4 <= tiff.length)
          tiff.fill(0, next, next + 2 + c1 * 12 + 4);
        set32(nextAt, 0);
        removed.push('EXIF thumbnail');
      } else {
        walkIfd(next, true);
      }
    }
  };
  walkIfd(u32(4), false);

  // Anything that still looks like a JPEG stream in the block is a preview: zero it.
  for (let at = 0; at + 3 < tiff.length; at++) {
    if (tiff[at] === 0xff && tiff[at + 1] === 0xd8 && tiff[at + 2] === 0xff) {
      const end = jpegStreamEnd(tiff, at);
      zero(at, end - at);
      removed.push('JPEG preview inside EXIF');
      at = end;
    }
  }
  return { payload: out, removed: [...new Set(removed)] };
}

/** End (exclusive) of the JPEG stream that starts at `start`; falls back to the next EOI. */
function jpegStreamEnd(data: Uint8Array, start: number): number {
  let pos = start + 2;
  while (pos + 3 < data.length) {
    if (data[pos] !== 0xff) break;
    const marker = data[pos + 1]!;
    if (marker === 0xd9) return pos + 2;
    if (marker === 0xda) {
      for (let i = pos + 4; i + 1 < data.length; i++) {
        if (data[i] === 0xff && data[i + 1] === 0xd9) return i + 2;
      }
      break;
    }
    pos += 2 + ((data[pos + 2]! << 8) | data[pos + 3]!);
  }
  for (let i = start + 2; i + 1 < data.length; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xd9) return i + 2;
  }
  return Math.min(data.length, start + 4);
}
