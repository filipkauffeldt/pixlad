import { describe, expect, it } from 'vitest';
import {
  holdsFace,
  notHands,
  notOversized,
  oneFacePerPerson,
  onePerPerson,
  windows,
  withoutFragments,
  type Box,
  type Person,
} from '../src/main/faces/people';

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

const person = (b: Box, extra: Partial<Person> = {}): Person => ({
  box: b,
  score: 0.9,
  landmarks: [],
  kind: 'face',
  from: 'yunet',
  ...extra,
});

describe('a head that holds a face', () => {
  const head = person(box(0, 0, 100, 100), { kind: 'head', from: 'deimv2', score: 0.5 });
  /** A 50x50 face whose centre is at (cx, cy). */
  const faceAt = (cx: number, cy: number) => person(box(cx - 25, cy - 25, 50, 50));

  it('holds a face in the middle of it', () => {
    expect(holdsFace(head, faceAt(50, 45))).toBe(true);
  });

  it('holds a face up to a quarter of the head width off centre, not further', () => {
    expect(holdsFace(head, faceAt(75, 45))).toBe(true);
    expect(holdsFace(head, faceAt(25, 45))).toBe(true);
    expect(holdsFace(head, faceAt(75.5, 45))).toBe(false);
    expect(holdsFace(head, faceAt(24.5, 45))).toBe(false);
  });

  it('holds a face whose centre is between 20% and 70% down the head, not above or below', () => {
    expect(holdsFace(head, faceAt(50, 20))).toBe(true);
    expect(holdsFace(head, faceAt(50, 70))).toBe(true);
    expect(holdsFace(head, faceAt(50, 19.5))).toBe(false);
    expect(holdsFace(head, faceAt(50, 70.5))).toBe(false);
  });

  it('holds a face down to a sixth of the head area, not a smaller one', () => {
    const face = (side: number) => person(box(50 - side / 2, 45 - side / 2, side, side));
    expect(holdsFace(head, face(41))).toBe(true); // 1681 * 6 = 10086
    expect(holdsFace(head, face(40))).toBe(false); // 1600 * 6 = 9600
  });

  it('is held by a head scoring 0.4 or better, not a weaker one', () => {
    expect(holdsFace({ ...head, score: 0.4 }, faceAt(50, 45))).toBe(true);
    expect(holdsFace({ ...head, score: 0.39 }, faceAt(50, 45))).toBe(false);
  });
});

describe('dropping fragments', () => {
  const whole = person(box(0, 0, 100, 100));
  /** A 10x10 box with `shared` px of its area inside the whole. */
  const shared = (area: number) => person(box(100 - area / 10, 0, 10, 10));

  it('drops a box with 60% of its area inside a larger one', () => {
    expect(withoutFragments([whole, shared(60)])).toEqual([whole]);
  });

  it('keeps a box with less than 60% of its area inside a larger one', () => {
    expect(withoutFragments([whole, shared(59)])).toEqual([whole, shared(59)]);
  });

  it('drops the smaller whatever the order of the input', () => {
    expect(withoutFragments([shared(100), whole])).toEqual([whole]);
  });
});

describe('dropping what is far bigger than the crowd', () => {
  /** Seven 10x10 faces: with the oversized one the eighth, enough for the median to count. */
  const crowd = Array.from({ length: 7 }, (_, i) => person(box(i * 20, 500, 10, 10)));
  const oversized = (area: number, extra: Partial<Person> = {}) =>
    person(box(0, 0, area / 20, 20), extra);

  it('drops a detection of more than 5x the median area', () => {
    expect(notOversized([...crowd, oversized(501)], [])).toEqual(crowd);
  });

  it('keeps a detection of exactly 5x the median area', () => {
    const big = oversized(500);
    expect(notOversized([...crowd, big], [])).toEqual([...crowd, big]);
  });

  it('trusts any size with fewer than 8 detections', () => {
    const six = crowd.slice(1);
    const big = oversized(100_000);
    expect(notOversized([...six, big], [])).toEqual([...six, big]);
  });

  describe('when the other kind of detection saw something of a matching size there', () => {
    const big = oversized(600); // a 30x20 face at the origin
    const head = (b: Box, extra: Partial<Person> = {}) =>
      person(b, { kind: 'head', from: 'deimv2', ...extra });
    const survives = (witness: Person) => notOversized([...crowd, big], [witness]).includes(big);

    it('keeps it for a head inside it', () => {
      expect(survives(head(box(0, 0, 30, 10)))).toBe(true);
    });

    it('ignores a witness of the same kind', () => {
      expect(survives(person(box(0, 0, 30, 10)))).toBe(false);
    });

    it('ignores a witness that does not touch it', () => {
      expect(survives(head(box(40, 0, 30, 10)))).toBe(false);
    });

    it('accepts a witness down to a quarter of its size, not a smaller one', () => {
      expect(survives(head(box(0, 0, 15, 10)))).toBe(true); // 150: it is 4x
      expect(survives(head(box(0, 0, 14.9, 10)))).toBe(false); // 149
    });

    it('accepts a witness up to 4x its size, not a larger one', () => {
      expect(survives(head(box(-10, -10, 60, 40)))).toBe(true); // 2400: it is 0.25x
      expect(survives(head(box(-10, -10, 49, 49)))).toBe(false); // 2401
    });

    it('wants the overlap to be 15% of the larger box', () => {
      // Against a 60x40 head (2400 px) it must be 360 px: 18 of the face's 30 columns, 20 high.
      expect(survives(head(box(12, -10, 60, 40)))).toBe(true);
      expect(survives(head(box(12.1, -10, 60, 40)))).toBe(false);
    });

    it('wants the overlap to be half of the smaller box', () => {
      // Against a 50x20 head (1000 px) it must be 300 px: 15 of the face's 30 columns, 20 high.
      expect(survives(head(box(15, 0, 50, 20)))).toBe(true);
      expect(survives(head(box(15.1, 0, 50, 20)))).toBe(false);
    });
  });

  it('takes the upper middle of the sorted areas as the median', () => {
    // Four 10x10 and four 100x10: the median is the fifth of eight, 1000 px, so nothing is 5x it.
    const mixed = [
      ...Array.from({ length: 4 }, (_, i) => person(box(i * 20, 500, 10, 10))),
      ...Array.from({ length: 4 }, (_, i) => person(box(i * 200, 700, 100, 10))),
    ];
    expect(notOversized(mixed, [])).toEqual(mixed);
  });
});

describe('dropping a hand taken for a face', () => {
  const face = person(box(0, 0, 10, 10), { score: 0.7 });
  /** A hand sharing `area` px of the 100 px face. */
  const handOver = (area: number) => box(10 - area / 10, 0, 10, 10);

  it('drops a detection with half its area inside a hand', () => {
    expect(notHands([face], [handOver(50)], [])).toEqual([]);
  });

  it('keeps a detection with less than half its area inside a hand', () => {
    expect(notHands([face], [handOver(49)], [])).toEqual([face]);
  });

  it('keeps a face YuNet scores 0.8 or better', () => {
    const sure = person(box(0, 0, 10, 10), { score: 0.8 });
    const unsure = person(box(0, 0, 10, 10), { score: 0.79 });
    expect(notHands([sure], [box(0, 0, 10, 10)], [])).toEqual([sure]);
    expect(notHands([unsure], [box(0, 0, 10, 10)], [])).toEqual([]);
  });

  it('does not trust the score of a face that did not come from YuNet', () => {
    const dehazed = person(box(0, 0, 10, 10), { score: 0.95, from: 'dehazed' });
    expect(notHands([dehazed], [box(0, 0, 10, 10)], [])).toEqual([]);
  });

  it('keeps a face that DEIMv2 also found as a face, with half of the smaller box shared', () => {
    expect(notHands([face], [box(0, 0, 10, 10)], [box(5, 0, 10, 10)])).toEqual([face]);
    expect(notHands([face], [box(0, 0, 10, 10)], [box(5.1, 0, 10, 10)])).toEqual([]);
  });
});

describe('one face per person', () => {
  it('keeps a face that is covered by less than half by stronger faces', () => {
    const weak = person(box(0, 0, 10, 10), { score: 0.7 });
    const strong = person(box(5.1, 0, 10, 10), { score: 0.9 }); // covers 49
    expect(oneFacePerPerson([weak, strong])).toEqual([weak, strong]);
  });

  it('drops a face that is covered by half by stronger faces', () => {
    const weak = person(box(0, 0, 10, 10), { score: 0.7 });
    const strong = person(box(5, 0, 10, 10), { score: 0.9 }); // covers 50
    expect(oneFacePerPerson([weak, strong])).toEqual([strong]);
  });

  it('adds up what several stronger faces cover', () => {
    const weak = person(box(0, 0, 10, 10), { score: 0.7 });
    const left = person(box(-7, 0, 10, 10), { score: 0.9 }); // covers 30
    const right = person(box(7, 0, 10, 10), { score: 0.8 }); // covers 30
    expect(oneFacePerPerson([weak, left, right])).toEqual([left, right]);
  });

  it('is not covered by a weaker face', () => {
    const strong = person(box(0, 0, 10, 10), { score: 0.9 });
    const weak = person(box(5, 0, 10, 10), { score: 0.7 });
    expect(oneFacePerPerson([strong, weak])).toContain(strong);
  });

  it('is only covered by faces smaller than 4x its area', () => {
    const weak = person(box(0, 0, 10, 10), { score: 0.7 });
    const covers = (area: number) => person(box(5, 0, area / 20, 20), { score: 0.9 });
    expect(oneFacePerPerson([weak, covers(399)])).not.toContain(weak);
    expect(oneFacePerPerson([weak, covers(400)])).toContain(weak);
  });

  describe('a big box that holds the centres of smaller faces', () => {
    const big = person(box(0, 0, 20, 20), { score: 0.9 }); // 400 px
    const small = (x: number, area: number) => person(box(x, 5, 10, area / 10), { score: 0.5 });

    it('is a loose box over several people, and is dropped for two or more', () => {
      expect(oneFacePerPerson([big, small(0, 100), small(10, 100)])).toEqual([
        small(0, 100),
        small(10, 100),
      ]);
    });

    it('is a face for one', () => {
      expect(oneFacePerPerson([big, small(0, 100)])).toEqual([big]);
    });

    it('counts only faces under half its area', () => {
      expect(oneFacePerPerson([big, small(0, 199), small(10, 199)])).not.toContain(big);
      expect(oneFacePerPerson([big, small(0, 200), small(10, 200)])).toEqual([big]);
    });

    it('counts only faces whose centre lies inside it, the edge included', () => {
      expect(oneFacePerPerson([big, small(0, 100), small(15.1, 100)])).toContainEqual(big);
      expect(oneFacePerPerson([big, small(0, 100), small(15, 100)])).not.toContainEqual(big);
    });
  });
});

describe('one detection per person', () => {
  const large = person(box(0, 0, 20, 20));
  /** A 10x10 box with `area` px of its 100 px inside `large`. */
  const sharing = (area: number, extra: Partial<Person> = {}) =>
    person(box(20 - area / 10, 0, 10, 10), extra);

  it('merges a detection with 60% of its area inside a larger one', () => {
    expect(onePerPerson([large, sharing(60)])).toEqual([large]);
  });

  it('keeps a detection with less than 60% of its area inside a larger one', () => {
    expect(onePerPerson([large, sharing(59)])).toHaveLength(2);
  });

  it('keeps two boxes of one size that share 59% of their area', () => {
    const a = person(box(0, 0, 10, 10));
    const b = person(box(4.1, 0, 10, 10));
    expect(onePerPerson([a, b])).toHaveLength(2);
  });

  it('merges a detection into one of up to 4x its area, not more', () => {
    const inside = person(box(0, 0, 10, 10));
    const around = (area: number) => person(box(0, 0, area / 20, 20));
    expect(onePerPerson([inside, around(400)])).toEqual([around(400)]);
    expect(onePerPerson([inside, around(401)])).toHaveLength(2);
  });

  it('keeps boxes that do not touch', () => {
    expect(onePerPerson([large, person(box(20, 0, 10, 10))])).toHaveLength(2);
  });

  it('lets the larger box take the confirmation, landmarks and eyes of the one it absorbs', () => {
    const eyes = [box(2, 2, 3, 3)];
    const landmarks = [{ x: 1, y: 1 }];
    const [merged] = onePerPerson([
      person(box(0, 0, 20, 20), { kind: 'head', from: 'deimv2' }),
      sharing(100, { confirmed: true, landmarks, eyes }),
    ]);
    expect(merged).toMatchObject({ kind: 'head', confirmed: true, landmarks, eyes });
  });

  it('keeps the landmarks of the larger box when it has some', () => {
    const own = [{ x: 9, y: 9 }];
    const [merged] = onePerPerson([
      person(box(0, 0, 20, 20), { landmarks: own }),
      sharing(100, { landmarks: [{ x: 1, y: 1 }] }),
    ]);
    expect(merged!.landmarks).toEqual(own);
  });
});

describe('the windows DEIMv2 looks through', () => {
  const region = (side: number) => box(0, 0, side, side);

  it('tiles a region of up to 640 px even when only the whole is asked for', () => {
    expect(windows(region(640), 2560, false, true)).toEqual([
      { win: box(0, 0, 640, 640), scale: 1, whole: false },
    ]);
  });

  it('looks at a region over 640 px only as a whole, unless tiles are asked for', () => {
    expect(windows(region(641), 2560, false, true)).toEqual([
      { win: box(0, 0, 641, 641), scale: 640 / 641, whole: true },
    ]);
    expect(windows(region(641), 2560, false, false)).toEqual([]);
  });

  it('adds the whole region after the tiles when both are asked for', () => {
    const found = windows(region(1000), 1000, true, true);
    expect(found.map((w) => w.whole)).toEqual([false, false, false, false, true]);
  });

  it('steps tiles by 80% of their size', () => {
    const tiles = windows(region(1000), 1000, true, false).map((w) => w.win);
    expect(tiles).toEqual([
      box(0, 0, 640, 640),
      box(512, 0, 488, 640),
      box(0, 512, 640, 488),
      box(512, 512, 488, 488),
    ]);
  });

  it('makes tiles larger by what the region is scaled down, so they stay 640 px in the copy', () => {
    const tiles = windows(region(2000), 1000, true, false);
    expect(tiles.map((w) => w.win)).toEqual([
      box(0, 0, 1280, 1280),
      box(1024, 0, 976, 1280),
      box(0, 1024, 1280, 976),
      box(1024, 1024, 976, 976),
    ]);
    expect(tiles.every((w) => w.scale === 0.5)).toBe(true);
  });

  it('never scales a region up', () => {
    expect(windows(region(500), 2560, true, false)[0]!.scale).toBe(1);
  });
});
