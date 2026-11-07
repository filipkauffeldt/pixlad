import { JpegError } from './errors';
import { ZIGZAG, parseHeader, type ParsedHeader } from './parse';

export interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Blocks across / down the component's own (subsampled) size. */
  blocksPerLine: number;
  blocksPerColumn: number;
  /** The same, padded to whole MCUs: the storage layout. */
  stride: number;
  rows: number;
  /** Quantized coefficients, natural order, 64 per block, row-major in `stride` x `rows` blocks. */
  coeffs: Int16Array;
  /** With `dcOnly`: the DC value of each block (`stride * rows` entries). */
  dc?: Int16Array;
}

export interface Decoded {
  header: ParsedHeader;
  components: Component[];
  mcusPerLine: number;
  mcusPerColumn: number;
}

interface HuffTable {
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  values: Uint8Array;
}

function buildHuffman(bits: Uint8Array, values: Uint8Array): HuffTable {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += bits[l - 1]!;
    k += bits[l - 1]!;
    maxcode[l] = bits[l - 1]! > 0 ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, values };
}

class BitReader {
  pos: number;
  private buf = 0;
  private cnt = 0;
  /** Set when a marker was met while reading: the stream is padded with zeros. */
  hitMarker = false;
  constructor(
    readonly data: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }

  bit(): number {
    if (this.cnt === 0) {
      let byte = 0;
      if (this.hitMarker || this.pos >= this.data.length) {
        this.hitMarker = true;
      } else {
        byte = this.data[this.pos]!;
        if (byte === 0xff) {
          const next = this.data[this.pos + 1];
          if (next === 0) this.pos += 2;
          else {
            this.hitMarker = true;
            byte = 0;
          }
        } else this.pos++;
      }
      this.buf = byte;
      this.cnt = 8;
    }
    this.cnt--;
    return (this.buf >> this.cnt) & 1;
  }

  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  huff(table: HuffTable): number {
    let code = this.bit();
    let l = 1;
    while (code > table.maxcode[l]!) {
      code = (code << 1) | this.bit();
      if (++l > 16) throw new JpegError('corrupt', 'has invalid entropy-coded data');
    }
    return table.values[table.valptr[l]! + code - table.mincode[l]!]!;
  }

  /** Drop the partial byte, as at a restart marker. */
  align(): void {
    this.cnt = 0;
  }
}

const extend = (v: number, n: number): number =>
  n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v;

interface ScanComponent {
  comp: Component;
  dc: HuffTable | undefined;
  ac: HuffTable | undefined;
}

/**
 * Entropy-decode a JPEG into quantized DCT coefficients: baseline, extended sequential and
 * progressive Huffman. With `dcOnly` only the DC of each block is kept, which is enough for an
 * eighth-size thumbnail and needs far less memory.
 */
export function decodeCoefficients(data: Uint8Array, options: { dcOnly?: boolean } = {}): Decoded {
  const header = parseHeader(data);
  const { frame } = header;
  const dcOnly = options.dcOnly === true;
  const mcusPerLine = Math.ceil(frame.width / (8 * frame.hmax));
  const mcusPerColumn = Math.ceil(frame.height / (8 * frame.vmax));
  const components: Component[] = frame.components.map((info) => {
    const blocksPerLine = Math.ceil(Math.ceil((frame.width * info.h) / frame.hmax) / 8);
    const blocksPerColumn = Math.ceil(Math.ceil((frame.height * info.v) / frame.vmax) / 8);
    const stride = mcusPerLine * info.h;
    const rows = mcusPerColumn * info.v;
    const comp: Component = {
      ...info,
      blocksPerLine,
      blocksPerColumn,
      stride,
      rows,
      coeffs: new Int16Array(dcOnly ? 64 : stride * rows * 64),
    };
    if (dcOnly) comp.dc = new Int16Array(stride * rows);
    return comp;
  });

  const dcTables = new Map<number, HuffTable>();
  const acTables = new Map<number, HuffTable>();
  let restartInterval = 0;
  let pos = header.scanStart;

  const readTables = (payload: Uint8Array): void => {
    for (let at = 0; at < payload.length;) {
      const tc = payload[at]! >> 4;
      const th = payload[at]! & 15;
      const bits = payload.subarray(at + 1, at + 17);
      let total = 0;
      for (const b of bits) total += b;
      const values = payload.subarray(at + 17, at + 17 + total);
      (tc === 0 ? dcTables : acTables).set(th, buildHuffman(bits, values));
      at += 17 + total;
    }
  };
  for (const segment of header.segments) {
    if (segment.marker === 0xc4) readTables(segment.payload);
    else if (segment.marker === 0xdd)
      restartInterval = (segment.payload[0]! << 8) | segment.payload[1]!;
  }

  for (;;) {
    while (pos < data.length && data[pos] !== 0xff) pos++;
    while (pos < data.length && data[pos] === 0xff) pos++;
    if (pos >= data.length) break;
    const marker = data[pos++]!;
    if (marker === 0xd9) break;
    if (marker === 0 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const length = (data[pos]! << 8) | data[pos + 1]!;
    const payload = data.subarray(pos + 2, pos + length);
    pos += length;
    if (marker === 0xc4) {
      readTables(payload);
    } else if (marker === 0xdd) {
      restartInterval = (payload[0]! << 8) | payload[1]!;
    } else if (marker === 0xda) {
      const count = payload[0]!;
      const scanComps: ScanComponent[] = [];
      for (let i = 0; i < count; i++) {
        const id = payload[1 + i * 2]!;
        const tables = payload[2 + i * 2]!;
        const comp = components.find((c) => c.id === id);
        if (!comp) throw new JpegError('corrupt', 'has a scan for an unknown component');
        scanComps.push({ comp, dc: dcTables.get(tables >> 4), ac: acTables.get(tables & 15) });
      }
      const ss = payload[1 + count * 2]!;
      const se = payload[2 + count * 2]!;
      const ah = payload[3 + count * 2]! >> 4;
      const al = payload[3 + count * 2]! & 15;
      if (dcOnly && frame.progressive && (ss !== 0 || ah !== 0)) {
        // Only the first DC scan matters for a thumbnail; skip entropy data of the others.
        pos = skipEntropy(data, pos);
        if (ss !== 0 && components.every((c) => c.dc)) break;
        continue;
      }
      const reader = new BitReader(data, pos);
      decodeScan(
        reader,
        frame,
        header,
        scanComps,
        mcusPerLine,
        restartInterval,
        ss,
        se,
        ah,
        al,
        dcOnly,
      );
      pos = skipEntropy(data, reader.pos);
    }
  }
  return { header, components, mcusPerLine, mcusPerColumn };
}

/** Advance to the next real marker (not a stuffed 0xFF00 or a restart marker). */
function skipEntropy(data: Uint8Array, from: number): number {
  let pos = from;
  while (pos + 1 < data.length) {
    if (data[pos] === 0xff) {
      const next = data[pos + 1]!;
      if (next !== 0 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) return pos;
    }
    pos++;
  }
  return data.length;
}

function decodeScan(
  r: BitReader,
  frame: ParsedHeader['frame'],
  _header: ParsedHeader,
  scanComps: ScanComponent[],
  mcusPerLine: number,
  restartInterval: number,
  ss: number,
  se: number,
  ah: number,
  al: number,
  dcOnly: boolean,
): void {
  const progressive = frame.progressive;
  const preds = new Int32Array(scanComps.length);
  let eobrun = 0;
  const scratch = new Int16Array(64);

  for (const sc of scanComps) {
    if (!progressive || ss === 0) {
      if (ah === 0 && !sc.dc && (!progressive || ss === 0)) {
        throw new JpegError('corrupt', 'is missing a Huffman table');
      }
    }
    if ((!progressive || ss > 0) && !sc.ac)
      throw new JpegError('corrupt', 'is missing a Huffman table');
  }

  const decodeBlock = (sc: ScanComponent, index: number, c: Int16Array, off: number): void => {
    if (!progressive) {
      const t = r.huff(sc.dc!);
      preds[index] = preds[index]! + (t === 0 ? 0 : extend(r.receive(t), t));
      c[off] = preds[index]!;
      let k = 1;
      while (k < 64) {
        const rs = r.huff(sc.ac!);
        const s = rs & 15;
        const run = rs >> 4;
        if (s === 0) {
          if (run < 15) break;
          k += 16;
          continue;
        }
        k += run;
        if (k > 63) break;
        c[off + ZIGZAG[k]!] = extend(r.receive(s), s);
        k++;
      }
      return;
    }
    if (ss === 0) {
      if (ah === 0) {
        const t = r.huff(sc.dc!);
        preds[index] = preds[index]! + (t === 0 ? 0 : extend(r.receive(t), t));
        c[off] = preds[index]! * (1 << al);
      } else if (r.bit()) c[off] = c[off]! | (1 << al);
      return;
    }
    // AC scans
    if (ah === 0) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      let k = ss;
      while (k <= se) {
        const rs = r.huff(sc.ac!);
        const s = rs & 15;
        const run = rs >> 4;
        if (s === 0) {
          if (run < 15) {
            eobrun = r.receive(run) + (1 << run) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += run;
        if (k > 63) break;
        c[off + ZIGZAG[k]!] = extend(r.receive(s), s) * (1 << al);
        k++;
      }
      return;
    }
    // AC refinement (libjpeg's decode_mcu_AC_refine)
    const p1 = 1 << al;
    const m1 = -1 << al;
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k++) {
        const rs = r.huff(sc.ac!);
        let s = rs & 15;
        let run = rs >> 4;
        if (s) s = r.bit() ? p1 : m1;
        else if (run !== 15) {
          eobrun = 1 << run;
          if (run) eobrun += r.receive(run);
          break;
        }
        do {
          const z = off + ZIGZAG[k]!;
          if (c[z] !== 0) {
            if (r.bit() && (c[z]! & p1) === 0) c[z] = c[z]! + (c[z]! >= 0 ? p1 : m1);
          } else if (--run < 0) break;
          k++;
        } while (k <= se);
        if (s && k <= 63) c[off + ZIGZAG[k]!] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) {
        const z = off + ZIGZAG[k]!;
        if (c[z] !== 0 && r.bit() && (c[z]! & p1) === 0) c[z] = c[z]! + (c[z]! >= 0 ? p1 : m1);
      }
      eobrun--;
    }
  };

  const handleBlock = (sc: ScanComponent, index: number, row: number, col: number): void => {
    const comp = sc.comp;
    if (dcOnly) {
      scratch.fill(0);
      decodeBlock(sc, index, scratch, 0);
      comp.dc![row * comp.stride + col] = scratch[0]!;
    } else {
      decodeBlock(sc, index, comp.coeffs, (row * comp.stride + col) * 64);
    }
  };

  let mcuCount: number;
  let mcusAcross: number;
  const single = scanComps.length === 1;
  if (single) {
    mcusAcross = scanComps[0]!.comp.blocksPerLine;
    mcuCount = mcusAcross * scanComps[0]!.comp.blocksPerColumn;
  } else {
    mcusAcross = mcusPerLine;
    mcuCount = mcusPerLine * Math.ceil(frame.height / (8 * frame.vmax));
  }

  for (let mcu = 0; mcu < mcuCount; mcu++) {
    if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
      r.align();
      r.pos = skipToRestart(r.data, r.pos);
      r.hitMarker = false;
      preds.fill(0);
      eobrun = 0;
    }
    const mcuRow = Math.floor(mcu / mcusAcross);
    const mcuCol = mcu % mcusAcross;
    if (single) {
      handleBlock(scanComps[0]!, 0, mcuRow, mcuCol);
    } else {
      for (let i = 0; i < scanComps.length; i++) {
        const sc = scanComps[i]!;
        for (let v = 0; v < sc.comp.v; v++) {
          for (let h = 0; h < sc.comp.h; h++) {
            handleBlock(sc, i, mcuRow * sc.comp.v + v, mcuCol * sc.comp.h + h);
          }
        }
      }
    }
  }
}

/** Find the RSTn marker that ends an interval and return the offset just after it. */
function skipToRestart(data: Uint8Array, from: number): number {
  let pos = from;
  while (pos + 1 < data.length) {
    if (data[pos] === 0xff && data[pos + 1]! >= 0xd0 && data[pos + 1]! <= 0xd7) return pos + 2;
    if (data[pos] === 0xff && data[pos + 1] !== 0 && data[pos + 1] !== 0xff) return pos;
    pos++;
  }
  return data.length;
}
