import { beforeEach, describe, expect, it, vi } from 'vitest';
import { outlineModel } from '../src/main/faces/models';
import { traceOutlines, type TraceItem } from '../src/main/faces/outlines';
import type { Box } from '../src/main/faces/people';
import type { Point } from '../src/shared/types';

vi.mock('../src/main/faces/models', () => ({ outlineModel: vi.fn() }));

const SEGMENTER_EDGE = 256;
const BACKGROUND = 0;
const HAIR = 1;
const BODY_SKIN = 2;
const FACE_SKIN = 3;
const CLOTHES = 4;

type Paint = (u: number, v: number) => number;

const segmenter = (paint: Paint) => {
  const run = vi.fn(async () => {
    const scores = new Float32Array(SEGMENTER_EDGE * SEGMENTER_EDGE * 6);
    for (let v = 0; v < SEGMENTER_EDGE; v++) {
      for (let u = 0; u < SEGMENTER_EDGE; u++) {
        scores[(v * SEGMENTER_EDGE + u) * 6 + paint(u, v)] = 1;
      }
    }
    return { scores: { data: scores } };
  });
  vi.mocked(outlineModel).mockResolvedValue({
    inputNames: ['image'],
    outputNames: ['scores'],
    run,
  } as never);
  return run;
};

const photo = { rgba: new Uint8Array(1000 * 800 * 4).fill(128), width: 1000, height: 800 };

const centreSquare = (side: number, label: number): Paint => {
  const first = Math.floor(SEGMENTER_EDGE / 2 - side / 2);
  const inside = (position: number) => position >= first && position < first + side;
  return (u, v) => (inside(u) && inside(v) ? label : BACKGROUND);
};

const centredBox = (side: number, cx = 350, cy = 400): Box => ({
  x: cx - side / 2,
  y: cy - side / 2,
  w: side,
  h: side,
});

const item = (box: Box, extra: Partial<TraceItem> = {}): TraceItem => ({
  box,
  kind: 'face',
  angle: 0,
  confirmed: false,
  ...extra,
});

const outlineOf = async (traced: TraceItem): Promise<Point[] | null | undefined> =>
  (await traceOutlines(photo, [traced], 'models'))[0];

const widthOf = (points: Point[]): number => {
  const xs = points.map((p) => p.x);
  return Math.max(...xs) - Math.min(...xs);
};

beforeEach(() => {
  vi.mocked(outlineModel).mockReset();
});

describe('which faces get an outline', () => {
  it('traces a face whose long edge is 100 px', async () => {
    segmenter(() => FACE_SKIN);
    expect(await outlineOf(item(centredBox(100)))).toBeInstanceOf(Array);
  });

  it('keeps the oval for a face under 100 px', async () => {
    const run = segmenter(() => FACE_SKIN);
    expect(await outlineOf(item(centredBox(99)))).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the long edge of the box', async () => {
    segmenter(() => FACE_SKIN);
    const wide = { x: 300, y: 380, w: 100, h: 40 };
    expect(await outlineOf(item(wide))).toBeInstanceOf(Array);
  });
});

describe('a face that is a tattoo', () => {
  const centreCounts =
    (faceSkin: number, bodySkin: number): Paint =>
    (u, v) => {
      if (u < 64 || u >= 192 || v < 64 || v >= 192) return BACKGROUND;
      const index = (v - 64) * 128 + (u - 64);
      if (index < faceSkin) return FACE_SKIN;
      if (index < faceSkin + bodySkin) return BODY_SKIN;
      return BACKGROUND;
    };
  const confirmedFace = item(centredBox(100), { confirmed: true });

  it('is null when body skin fills over 30% of it and face skin under 3%', async () => {
    segmenter(centreCounts(491, 4916));
    expect(await outlineOf(confirmedFace)).toBeNull();
  });

  it('is a face when body skin fills 30% of it or less', async () => {
    segmenter(centreCounts(0, 4915));
    expect(await outlineOf(confirmedFace)).toBeInstanceOf(Array);
  });

  it('is a face when face skin fills 3% of it or more', async () => {
    segmenter(centreCounts(492, 4916));
    expect(await outlineOf(confirmedFace)).toBeInstanceOf(Array);
  });

  it('is never judged for a head', async () => {
    segmenter(centreCounts(0, 12000));
    expect(
      await outlineOf(item(centredBox(100), { kind: 'head', confirmed: true })),
    ).toBeInstanceOf(Array);
  });
});

describe('a head no detector confirmed as a face', () => {
  const head = item(centredBox(100), { kind: 'head' });

  it('is traced when the skin covers 35% of it', async () => {
    segmenter(centreSquare(94, FACE_SKIN));
    const outline = (await outlineOf(head)) as Point[];
    expect(widthOf(outline)).toBeLessThan(75);
  });

  it('gets an oval over the whole head when the skin covers less than 35%', async () => {
    segmenter(centreSquare(93, FACE_SKIN));
    const outline = (await outlineOf(head)) as Point[];
    expect(widthOf(outline)).toBeGreaterThan(85);
  });

  describe('covered by an oval that is left over once clothes are taken out', () => {
    const skinLeftOfClothesFrom =
      (clothesFrom: number): Paint =>
      (u, v) => {
        if (u >= 96 && u < 108 && v >= 122 && v < 134) return FACE_SKIN;
        return u >= clothesFrom ? CLOTHES : BACKGROUND;
      };

    it('follows the oval minus the clothes when 40% of it is left', async () => {
      segmenter(skinLeftOfClothesFrom(116));
      expect(await outlineOf(head)).toHaveLength(72);
    });

    it('is a plain oval when under 40% of it is left', async () => {
      segmenter(skinLeftOfClothesFrom(112));
      expect(await outlineOf(head)).toHaveLength(40);
    });
  });
});

describe('a face with little skin for its size', () => {
  const face = item(centredBox(100));

  it('is grown to cover the opening when skin fills under 30% of it', async () => {
    segmenter(centreSquare(69, FACE_SKIN));
    const outline = (await outlineOf(face)) as Point[];
    expect(widthOf(outline)).toBeGreaterThan(70);
  });

  it('follows the skin when it fills 30% of it', async () => {
    segmenter(centreSquare(70, FACE_SKIN));
    const outline = (await outlineOf(face)) as Point[];
    expect(widthOf(outline)).toBeLessThan(70);
  });
});

describe('when the segmenter finds no skin or hair', () => {
  const nothing = () => BACKGROUND;
  const eyes: Box[] = [{ x: 320, y: 380, w: 20, h: 10 }];

  it('covers the eyeholes of a head that has eyes', async () => {
    segmenter(nothing);
    const outline = await outlineOf(item(centredBox(100), { kind: 'head', eyes }));
    expect(outline).toHaveLength(32);
  });

  it('leaves a head with no eyes sharp', async () => {
    segmenter(nothing);
    expect(await outlineOf(item(centredBox(100), { kind: 'head' }))).toBeNull();
  });

  it('leaves a face sharp', async () => {
    segmenter(nothing);
    expect(await outlineOf(item(centredBox(100)))).toBeNull();
  });

  it('keeps the oval for a confirmed face the segmenter sees only clothes in', async () => {
    segmenter(() => CLOTHES);
    expect(await outlineOf(item(centredBox(100), { confirmed: true }))).toBeUndefined();
  });

  it('covers the core of a confirmed face', async () => {
    segmenter(nothing);
    expect(await outlineOf(item(centredBox(100), { confirmed: true }))).toBeInstanceOf(Array);
  });

  it('does not count hair below the jaw as part of a face', async () => {
    segmenter((_, v) => (v < 128 ? FACE_SKIN : HAIR));
    const outline = (await outlineOf(item(centredBox(100), { confirmed: true }))) as Point[];
    const ys = outline.map((p) => p.y);
    expect(Math.max(...ys) - 400).toBeLessThan(55);
  });
});

describe('faces whose outlines are worked out in one segmenter run', () => {
  const faces = (...boxes: Box[]) => boxes.map((box) => item(box));
  const runsFor = async (...boxes: Box[]): Promise<number> => {
    const run = segmenter(() => BACKGROUND);
    await traceOutlines(photo, faces(...boxes), 'models');
    return run.mock.calls.length;
  };
  const own = centredBox(200);

  it('share a run when their crops fit in 1.5x the first crop', async () => {
    expect(await runsFor(own, centredBox(200, 552))).toBe(1);
  });

  it('get a run each when their crops need more than 1.5x the first crop', async () => {
    expect(await runsFor(own, centredBox(200, 553))).toBe(2);
  });

  it('share a run when the other crop is 0.7x the size or larger', async () => {
    expect(await runsFor(own, centredBox(144))).toBe(1);
  });

  it('get a run each when the other crop is under 0.7x the size', async () => {
    expect(await runsFor(own, centredBox(136))).toBe(2);
  });

  it('share a run when the other crop is up to 1/0.7 the size', async () => {
    expect(await runsFor(own, centredBox(280))).toBe(1);
  });

  it('get a run each when the other crop is over 1/0.7 the size', async () => {
    expect(await runsFor(own, centredBox(290))).toBe(2);
  });

  it('keep an outline of their own', async () => {
    segmenter(() => FACE_SKIN);
    const outlines = await traceOutlines(photo, faces(own, centredBox(200, 450)), 'models');
    expect(outlines.every((outline) => Array.isArray(outline))).toBe(true);
  });
});
