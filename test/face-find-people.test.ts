import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectFaces } from '../src/main/faces/detect';
import { outlineModel } from '../src/main/faces/models';
import { findPeople, type Box, type Person } from '../src/main/faces/people';

vi.mock('../src/main/faces/detect', () => ({ detectFaces: vi.fn() }));
vi.mock('../src/main/faces/models', () => ({ outlineModel: vi.fn() }));

const yunet = vi.mocked(detectFaces);
const models = vi.mocked(outlineModel);

const HEAD = 7;
const FACE = 16;
const EYE = 17;
const HAND = 26;

type Seen = readonly [cls: number, box: Box, score: number];
type Found = readonly [box: Box, score: number];

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

function fakeDeim(seen: readonly Seen[], size: number) {
  const rows = seen.flatMap(([cls, b, score]) => [
    cls,
    b.x / size,
    b.y / size,
    (b.x + b.w) / size,
    (b.y + b.h) / size,
    score,
  ]);
  return {
    run: async () => ({
      label_xyxy_score: { data: Float32Array.from(rows), dims: [1, seen.length, 6] },
    }),
  } as never;
}

interface Scene {
  size?: number;
  heads?: readonly Seen[];
  smallHeads?: readonly Seen[];
  faces?: readonly Found[] | ((copyWidth: number) => readonly Found[]);
  hazy?: readonly Found[];
  paint?: (rgba: Uint8Array, width: number) => void;
  width?: number;
  height?: number;
}

async function look(scene: Scene): Promise<Person[]> {
  const width = scene.width ?? scene.size ?? 640;
  const height = scene.height ?? scene.size ?? 640;
  const rgba = new Uint8Array(width * height * 4).fill(128);
  scene.paint?.(rgba, width);
  const sessions = {
    heads: fakeDeim(scene.heads ?? [], 640),
    smallHeads: fakeDeim(scene.smallHeads ?? [], 640),
  };
  models.mockImplementation(async (_dir, which) => (sessions as never)[which]);
  const asFaces = (list: readonly Found[]) =>
    list.map(([b, score]) => ({
      box: {
        type: 'rect' as const,
        x: b.x / width,
        y: b.y / height,
        w: b.w / width,
        h: b.h / height,
      },
      score,
      landmarks: [],
      angle: 0,
      aspect: width / height,
    }));
  yunet.mockImplementation(async (source, copyWidth) => {
    const dehazed = source !== rgba && copyWidth === width;
    if (!dehazed) {
      const faces = typeof scene.faces === 'function' ? scene.faces(copyWidth) : scene.faces;
      return asFaces(faces ?? []);
    }
    return asFaces(scene.hazy ?? []);
  });
  return findPeople({ rgba, width, height }, { type: 'rect', x: 0, y: 0, w: 1, h: 1 }, 'models');
}

const kinds = (people: Person[]) => people.map((p) => `${p.from} ${p.kind}`);

beforeEach(() => {
  yunet.mockReset();
  models.mockReset();
});

describe('heads that stand for people', () => {
  const head = box(100, 100, 100, 100);

  it('counts a head with no face when DEIMv2 scores it 0.5 or better', async () => {
    expect(kinds(await look({ heads: [[HEAD, head, 0.5]] }))).toEqual(['deimv2 head']);
    expect(await look({ heads: [[HEAD, head, 0.45]] })).toEqual([]);
  });

  it('ignores a head DEIMv2 scores under 0.35, even when it has eyes', async () => {
    const eye = box(130, 130, 20, 10);
    expect(
      await look({
        heads: [
          [HEAD, head, 0.34],
          [EYE, eye, 0.9],
        ],
      }),
    ).toEqual([]);
    expect(
      await look({
        heads: [
          [HEAD, head, 0.36],
          [EYE, eye, 0.9],
        ],
      }),
    ).toHaveLength(1);
  });

  it('counts a head that scores under 0.5 when an eye lies in it, and keeps the eye', async () => {
    const eye = box(130, 130, 20, 10);
    const [person] = await look({
      heads: [
        [HEAD, head, 0.4],
        [EYE, eye, 0.9],
      ],
    });
    expect(person).toMatchObject({ kind: 'head', eyes: [eye] });
  });

  it('ignores eyes DEIMv2 scores under 0.3', async () => {
    const eye = box(130, 130, 20, 10);
    expect(
      await look({
        heads: [
          [HEAD, head, 0.4],
          [EYE, eye, 0.299],
        ],
      }),
    ).toEqual([]);
    expect(
      await look({
        heads: [
          [HEAD, head, 0.4],
          [EYE, eye, 0.3],
        ],
      }),
    ).toHaveLength(1);
  });

  it('does not count a head with a face of its own', async () => {
    const face = [box(120, 120, 60, 60), 0.9] as const;
    const people = await look({ heads: [[HEAD, head, 0.9]], faces: [face] });
    expect(kinds(people)).toEqual(['yunet face']);
  });

  it('still counts a head that only covers the edge of a face box', async () => {
    const face = [box(0, 100, 100, 100), 0.9] as const;
    const people = await look({ heads: [[HEAD, box(55, 100, 100, 100), 0.9]], faces: [face] });
    expect(kinds(people).sort()).toEqual(['deimv2 head', 'yunet face']);
  });

  it('counts a face DEIMv2 found as a face, at 0.3', async () => {
    const face = box(100, 100, 60, 60);
    expect(kinds(await look({ heads: [[FACE, face, 0.3]] }))).toEqual(['deimv2 face']);
    expect(await look({ heads: [[FACE, face, 0.299]] })).toEqual([]);
  });
});

describe('heads that two models both found', () => {
  const big = box(100, 100, 100, 100);

  it('keeps the stronger of two heads that overlap by more than IoU 0.5', async () => {
    const small = box(100, 100, 100, 55);
    const people = await look({
      heads: [
        [HEAD, big, 0.6],
        [HEAD, small, 0.9],
      ],
    });
    expect(people.map((p) => p.box)).toEqual([small]);
  });

  it('keeps the larger of two heads that overlap by IoU 0.5 or less', async () => {
    const small = box(100, 100, 100, 50);
    const people = await look({
      heads: [
        [HEAD, big, 0.6],
        [HEAD, small, 0.9],
      ],
    });
    expect(people.map((p) => p.box)).toEqual([big]);
  });

  it('drops a small head that lies mostly inside a larger head', async () => {
    const inside = box(110, 110, 60, 60);
    const people = await look({
      heads: [
        [HEAD, big, 0.6],
        [HEAD, inside, 0.6],
      ],
    });
    expect(people.map((p) => p.box)).toEqual([big]);
  });

  describe('against heads the small model finds in tiles', () => {
    it('adds a head overlapping one of them by less than IoU 0.3', async () => {
      const people = await look({
        heads: [[HEAD, big, 0.9]],
        smallHeads: [[HEAD, box(160, 100, 100, 100), 0.9]],
      });
      expect(people).toHaveLength(2);
    });

    it('drops a head overlapping one of them by more than IoU 0.3', async () => {
      const people = await look({
        heads: [[HEAD, big, 0.9]],
        smallHeads: [[HEAD, box(150, 100, 100, 100), 0.9]],
      });
      expect(people).toHaveLength(1);
    });

    it('drops a head with 60% of it inside one of them, whatever the IoU', async () => {
      const people = await look({
        heads: [[HEAD, big, 0.9]],
        smallHeads: [[HEAD, box(160, 100, 50, 50), 0.9]],
      });
      expect(people).toHaveLength(1);
    });

    it('adds a head with only half of it inside one of them', async () => {
      const people = await look({
        heads: [[HEAD, big, 0.9]],
        smallHeads: [[HEAD, box(175, 100, 50, 50), 0.9]],
      });
      expect(people).toHaveLength(2);
    });
  });
});

describe('faces YuNet finds', () => {
  const face = box(100, 100, 100, 100);

  it('asks YuNet for faces down to 0.4', async () => {
    await look({ faces: [] });
    expect(yunet.mock.calls[0]![4]).toMatchObject({ scoreThreshold: 0.4 });
  });

  it('counts a face scoring 0.6 or better', async () => {
    expect(kinds(await look({ faces: [[face, 0.6]] }))).toEqual(['yunet face']);
    expect(await look({ faces: [[face, 0.59]] })).toEqual([]);
  });

  it('counts a face scoring under 0.6 when a head sits around it', async () => {
    const head = box(90, 50, 120, 150);
    const people = await look({ heads: [[HEAD, head, 0.9]], faces: [[face, 0.45]] });
    expect(kinds(people)).toEqual(['yunet face']);
  });

  it('does not count a weak face in a head that is too weak to vouch for it', async () => {
    const head = box(90, 50, 120, 150);
    expect(await look({ heads: [[HEAD, head, 0.39]], faces: [[face, 0.45]] })).toEqual([]);
  });

  it('ranks a face DEIMv2 also found as a face at 0.5, over a weaker YuNet face and under a stronger', async () => {
    const head = [HEAD, box(90, 50, 120, 150), 0.9] as const;
    const seen = [head, [FACE, face, 0.9]] as const;
    expect(kinds(await look({ heads: seen, faces: [[face, 0.45]] }))).toEqual(['deimv2 face']);
    expect(kinds(await look({ heads: seen, faces: [[face, 0.55]] }))).toEqual(['yunet face']);
  });

  it('drops a face with a detected hand over it, unless YuNet is sure of it', async () => {
    const hand = [HAND, face, 0.9] as const;
    expect(await look({ heads: [hand], faces: [[face, 0.79]] })).toEqual([]);
    expect(await look({ heads: [hand], faces: [[face, 0.8]] })).toHaveLength(1);
  });

  it('ignores a hand DEIMv2 scores under 0.35', async () => {
    expect(await look({ heads: [[HAND, face, 0.34]], faces: [[face, 0.7]] })).toHaveLength(1);
    expect(await look({ heads: [[HAND, face, 0.36]], faces: [[face, 0.7]] })).toEqual([]);
  });
});

describe('faces YuNet finds on shrunk copies', () => {
  const wide = { width: 2560, height: 128 };
  const copiesSearched = () =>
    yunet.mock.calls.filter(([, , , , options]) => options.scoreThreshold === 0.4).map((c) => c[1]);

  it('searches copies at 2560 and 1280 px only when they are under 1/1.5 of the long edge', async () => {
    await look({ width: 1920, height: 64 });
    expect(copiesSearched()).toEqual([1920]);
    yunet.mockReset();
    await look({ width: 1921, height: 64 });
    expect(copiesSearched()).toEqual([1921, 1280]);
    yunet.mockReset();
    await look({ width: 4000, height: 64 });
    expect(copiesSearched()).toEqual([4000, 2560, 1280]);
  });

  it('keeps a face found on a copy only if it spans 40 px of that copy', async () => {
    const face = (side: number) => box(100, 0, side, side);
    const onCopy = (side: number) => (copyWidth: number) =>
      copyWidth === 1280 ? ([[face(side), 0.9]] as const) : [];
    expect(await look({ ...wide, faces: onCopy(80) })).toHaveLength(1);
    expect(await look({ ...wide, faces: onCopy(75) })).toEqual([]);
  });

  it('keeps a small face found at full resolution', async () => {
    const small = [box(100, 0, 20, 20), 0.9] as const;
    expect(await look({ ...wide, faces: (w) => (w === 2560 ? [small] : []) })).toHaveLength(1);
  });
});

describe('the same face found twice', () => {
  const weak = (b: Box) => [b, 0.7] as const;
  const strong = (b: Box) => [b, 0.9] as const;

  it('keeps the stronger of two faces overlapping by more than IoU 0.4', async () => {
    const large = box(100, 100, 150, 100);
    const small = box(100, 100, 75, 90);
    const people = await look({ faces: [weak(large), strong(small)] });
    expect(people.map((p) => p.box)).toEqual([small]);
  });

  it('keeps the larger of two faces overlapping by IoU 0.4 or less', async () => {
    const large = box(100, 100, 150, 100);
    const small = box(100, 100, 75, 80);
    const people = await look({ faces: [weak(large), strong(small)] });
    expect(people.map((p) => p.box)).toEqual([large]);
  });
});

describe('a tall or wide face box that may be two faces', () => {
  const neighbour = [box(125, 70, 150, 150), 0.7] as const;

  it('is kept when it is no taller than 1.55x its width', async () => {
    const people = await look({ faces: [[box(100, 100, 100, 155), 0.9], neighbour] });
    expect(people).toHaveLength(2);
  });

  it('is dropped above 1.55x its width, when another face fills a good part of it', async () => {
    const people = await look({ faces: [[box(100, 100, 100, 160), 0.9], neighbour] });
    expect(people.map((p) => p.box)).toEqual([neighbour[0]]);
  });

  it('is kept when it is no wider than 1/0.65 of its height, a ratio of 0.65', async () => {
    const people = await look({
      faces: [
        [box(100, 100, 100, 65), 0.9],
        [box(160, 90, 150, 150), 0.7],
      ],
    });
    expect(people).toHaveLength(2);
  });

  it('is dropped under a ratio of 0.65, when another face fills a good part of it', async () => {
    const people = await look({
      faces: [
        [box(100, 100, 100, 60), 0.9],
        [box(160, 90, 150, 150), 0.7],
      ],
    });
    expect(people.map((p) => p.box)).toEqual([box(160, 90, 150, 150)]);
  });

  it('is kept when the other face fills less than 35% of it', async () => {
    const people = await look({
      faces: [
        [box(100, 100, 100, 160), 0.9],
        [box(135, 180, 150, 150), 0.7],
      ],
    });
    expect(people).toHaveLength(2);
  });

  it('is dropped when the other face fills 35% of it', async () => {
    const people = await look({
      faces: [
        [box(100, 100, 100, 160), 0.9],
        [box(130, 180, 150, 150), 0.7],
      ],
    });
    expect(people).toHaveLength(1);
  });
});

describe('faces in smoke', () => {
  const face = box(100, 100, 100, 100);
  const striped =
    (spread: number) =>
    (rgba: Uint8Array, width: number): void => {
      for (let y = 100; y < 200; y++) {
        for (let x = 100; x < 200; x++) {
          const v = 128 + (Math.floor(x / 2) % 2 === 0 ? -spread : spread);
          rgba.fill(v, (y * width + x) * 4, (y * width + x) * 4 + 3);
        }
      }
    };

  it('counts a face only the dehazed copy finds, where the photo is washed out', async () => {
    const people = await look({ hazy: [[face, 0.9]], paint: striped(29) });
    expect(kinds(people)).toEqual(['dehazed face']);
  });

  it('ignores a face only the dehazed copy finds where the photo has contrast of 30 or more', async () => {
    expect(await look({ hazy: [[face, 0.9]], paint: striped(31) })).toEqual([]);
  });

  it('ignores a dehazed face whose centre lies outside the searched area', async () => {
    expect(await look({ hazy: [[box(630, 630, 100, 100), 0.9]] })).toEqual([]);
  });

  it('prefers a plain face to a dehazed one that shares over 30% of the smaller box', async () => {
    const plain = [box(100, 100, 100, 100), 0.9] as const;
    const near = await look({ faces: [plain], hazy: [[box(165, 100, 100, 100), 0.9]] });
    const far = await look({ faces: [plain], hazy: [[box(170, 100, 100, 100), 0.9]] });
    expect(kinds(near)).toEqual(['yunet face']);
    expect(kinds(far).sort()).toEqual(['dehazed face', 'yunet face']);
  });
});
