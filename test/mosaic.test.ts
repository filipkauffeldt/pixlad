import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZE_PX,
  blockSizePxToRel,
  blockSizeRelToPx,
  defaultBlockPx,
} from '../src/shared/block-size';
import {
  pointInPolygon,
  polygonBounds,
  shapesBounds,
  simplifyPolygon,
  simplifyPolyline,
} from '../src/shared/geometry';
import { maskBounds, rasterizePolygonPixels, rasterizeRectPixels } from '../src/shared/mask';
import { blockSizeForShape, renderMosaic } from '../src/shared/mosaic';
import type { MosaicArea, Polygon, Rect } from '../src/shared/types';

const width = 160;
const height = 120;

const photo = (): Uint8Array => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 7 + y * 3) % 256;
      rgba[i + 1] = (x * 5 + y * 11) % 256;
      rgba[i + 2] = (x * y) % 256;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
};

const rect = (x: number, y: number, w: number, h: number): Rect => ({ type: 'rect', x, y, w, h });
const triangle: Polygon = {
  type: 'polygon',
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.7, y: 0.2 },
    { x: 0.3, y: 0.9 },
  ],
};
const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

const render = (areas: MosaicArea[], blockSizeRel = 0.05) => {
  const patch = renderMosaic(photo(), width, height, { areas, blockSizeRel });
  if (!patch) return undefined;
  return {
    box: [patch.x, patch.y, patch.width, patch.height],
    touched: patch.touched.reduce((sum, value) => sum + value, 0),
    rgba: digest(patch.rgba),
    mask: digest(patch.touched),
  };
};

describe('renderMosaic', () => {
  it('pixelates a rect on the block grid', () => {
    expect(render([{ shape: rect(0.2, 0.3, 0.4, 0.3) }])).toMatchInlineSnapshot(`
      {
        "box": [
          32,
          36,
          65,
          36,
        ],
        "mask": "89f5710fa51f162d",
        "rgba": "67756952681bf453",
        "touched": 2304,
      }
    `);
  });

  it('pixelates a polygon', () => {
    expect(render([{ shape: triangle }])).toMatchInlineSnapshot(`
      {
        "box": [
          16,
          12,
          96,
          96,
        ],
        "mask": "871959c3cbf83b71",
        "rgba": "f7ec9220e49eafcc",
        "touched": 4432,
      }
    `);
  });

  it('lets a subtract clear what came before and a later add cover it again', () => {
    const subtract = { shape: rect(0.3, 0.3, 0.2, 0.2), mode: 'subtract' as const };
    const add = { shape: rect(0.1, 0.1, 0.7, 0.7) };
    expect(render([add, subtract])).toMatchInlineSnapshot(`
      {
        "box": [
          16,
          12,
          112,
          84,
        ],
        "mask": "83b3bb11f7d46c4c",
        "rgba": "25c245aea6efac39",
        "touched": 8640,
      }
    `);
    expect(render([subtract, add])).toMatchInlineSnapshot(`
      {
        "box": [
          16,
          12,
          112,
          84,
        ],
        "mask": "68bad7fb34a9f87e",
        "rgba": "21d1e9f0908f0290",
        "touched": 9408,
      }
    `);
  });

  it('gives each size class its own grid, coarser on top', () => {
    const small = { shape: rect(0.05, 0.05, 0.9, 0.9) };
    const large = { shape: rect(0.5, 0.5, 0.2, 0.2) };
    expect(render([small, large], 0.05)).toMatchInlineSnapshot(`
      {
        "box": [
          8,
          6,
          144,
          109,
        ],
        "mask": "d28ec8334cbcaac0",
        "rgba": "d5bbfa2271713404",
        "touched": 15552,
      }
    `);
  });

  it('ignores disabled areas and returns nothing when nothing is covered', () => {
    expect(render([{ shape: rect(0.2, 0.3, 0.4, 0.3), enabled: false }])).toBeUndefined();
    expect(render([{ shape: rect(0.2, 0.3, 0, 0.3) }])).toBeUndefined();
    expect(render([])).toBeUndefined();
  });

  it('clips shapes that run past the image', () => {
    expect(render([{ shape: rect(0.8, 0.8, 0.5, 0.5) }])).toMatchInlineSnapshot(`
      {
        "box": [
          128,
          96,
          32,
          24,
        ],
        "mask": "1b1c08af714b3f3f",
        "rgba": "f9d81a4330c72b82",
        "touched": 768,
      }
    `);
  });

  it('rejects bad input', () => {
    expect(() => renderMosaic(photo(), 0, height, { areas: [], blockSizeRel: 0.1 })).toThrow(
      RangeError,
    );
    expect(() =>
      renderMosaic(new Uint8Array(4), width, height, { areas: [], blockSizeRel: 0.1 }),
    ).toThrow(RangeError);
    expect(() => renderMosaic(photo(), width, height, { areas: [], blockSizeRel: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('blockSizeForShape', () => {
  it('never goes below the floor and grows so a shape spans at most 8 blocks', () => {
    expect(blockSizeForShape(rect(0, 0, 0.5, 0.5), 0.001, 1000, 800)).toBe(50);
    expect(blockSizeForShape(rect(0, 0, 0.01, 0.01), 0.001, 1000, 800)).toBe(8);
    expect(blockSizeForShape(rect(0, 0, 0, 0), 0.05, 1000, 800)).toBe(50);
    expect(blockSizeForShape(rect(0, 0, 1, 1), 0.05, 1000, 800)).toBe(100);
    expect(blockSizeForShape(triangle, 0.01, 1000, 800)).toBe(
      Math.ceil(Math.min(0.6 * 1000, 0.8 * 800) / 8),
    );
    expect(() => blockSizeForShape(triangle, -1, 1000, 800)).toThrow(RangeError);
  });
});

describe('block size', () => {
  it('converts between pixels and a fraction of the long edge', () => {
    expect(blockSizePxToRel(20, 4000)).toBe(0.005);
    expect(blockSizePxToRel(0.2, 4000)).toBe(1 / 4000);
    expect(blockSizeRelToPx(0.005, 4000)).toBe(20);
    expect(blockSizeRelToPx(0, 4000)).toBe(1);
  });

  it('starts at about 1% of the long edge within the toolbar range', () => {
    expect(defaultBlockPx(4000)).toBe(40);
    expect(defaultBlockPx(100)).toBe(BLOCK_SIZE_PX.min);
    expect(defaultBlockPx(100_000)).toBe(BLOCK_SIZE_PX.max);
  });
});

describe('rasterizing', () => {
  const ones = (mask: Uint8Array): number => mask.reduce((sum, value) => sum + value, 0);

  const rows = (mask: Uint8Array, columns: number): string[] => {
    const lines: string[] = [];
    for (let i = 0; i < mask.length; i += columns) {
      lines.push(Array.from(mask.slice(i, i + columns)).join(''));
    }
    return lines;
  };

  it('selects pixels whose centre is inside a rect, the top and left edges included', () => {
    const mask = rasterizeRectPixels({ x: 1.4, y: 0.5, w: 2, h: 1 }, 6, 3);
    expect(rows(mask, 6)).toEqual(['011000', '000000', '000000']);
    expect(maskBounds(mask, 6, 3)).toEqual({ x: 1, y: 0, w: 2, h: 1 });
    expect(maskBounds(new Uint8Array(4), 2, 2)).toBeUndefined();
  });

  it('shifts by the offset and clips to the mask', () => {
    const mask = rasterizeRectPixels({ x: 10, y: 10, w: 100, h: 100 }, 4, 4, undefined, 9, 9);
    expect(ones(mask)).toBe(9);
    expect(ones(rasterizeRectPixels({ x: 0, y: 0, w: 2, h: 2 }, 4, 4, undefined, 9, 9))).toBe(0);
  });

  it('fills polygons even-odd', () => {
    const bowtie = [
      { x: 0, y: 0 },
      { x: 8, y: 8 },
      { x: 8, y: 0 },
      { x: 0, y: 8 },
    ];
    expect(rows(rasterizePolygonPixels(bowtie, 8, 8), 8)).toMatchInlineSnapshot(`
      [
        "00000001",
        "10000011",
        "11000111",
        "11101111",
        "11101111",
        "11000111",
        "10000011",
        "00000001",
      ]
    `);
  });

  it('rasterizes a triangle', () => {
    const mask = rasterizePolygonPixels(
      [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 0, y: 8 },
      ],
      8,
      8,
    );
    expect(rows(mask, 8)).toMatchInlineSnapshot(`
      [
        "11111110",
        "11111100",
        "11111000",
        "11110000",
        "11100000",
        "11000000",
        "10000000",
        "00000000",
      ]
    `);
  });
});

describe('geometry', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];

  it('tests points against a polygon', () => {
    expect(pointInPolygon({ x: 2, y: 2 }, square)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 2 }, square)).toBe(false);
    expect(pointInPolygon({ x: 2, y: 2 }, square.slice(0, 2))).toBe(false);
  });

  it('takes bounds of polygons and shape lists', () => {
    expect(polygonBounds(square)).toEqual(rect(0, 0, 4, 4));
    expect(polygonBounds([])).toEqual(rect(0, 0, 0, 0));
    expect(shapesBounds([rect(0, 0, 0, 1), rect(1, 1, 1, 1), rect(3, 0, 1, 2)])).toEqual(
      rect(1, 0, 3, 2),
    );
    expect(shapesBounds([])).toBeUndefined();
  });

  it('simplifies lines and rings', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0.01 },
      { x: 2, y: 0 },
      { x: 3, y: 2 },
    ];
    expect(simplifyPolyline(line, 0.1)).toEqual([line[0], line[2], line[3]]);
    expect(simplifyPolyline(line.slice(0, 2), 5)).toEqual(line.slice(0, 2));
    const ring = [...square.slice(0, 2), { x: 4, y: 2 }, ...square.slice(2)];
    expect(simplifyPolygon(ring, 0.1)).toMatchInlineSnapshot(`
      [
        {
          "x": 0,
          "y": 0,
        },
        {
          "x": 4,
          "y": 0,
        },
        {
          "x": 4,
          "y": 4,
        },
        {
          "x": 0,
          "y": 4,
        },
      ]
    `);
    expect(simplifyPolygon(square.slice(0, 3), 1)).toEqual(square.slice(0, 3));
  });
});
