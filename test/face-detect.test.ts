import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectFaces, type DetectFacesOptions } from '../src/main/faces/detect';
import { runYuNet, type FaceCandidate } from '../src/main/faces/yunet';

vi.mock('../src/main/faces/yunet', () => ({ runYuNet: vi.fn() }));

const detector = vi.mocked(runYuNet);
const modelPath = 'unused.onnx';

const candidate = (x: number, y: number, w: number, h: number, score = 0.9): FaceCandidate => ({
  box: { x, y, w, h },
  score,
  landmarks: [],
});

const photo = (width: number, height: number) => new Uint8Array(width * height * 4);

beforeEach(() => {
  detector.mockReset();
  detector.mockResolvedValue([]);
});

function lookedAt(photoWidth: number) {
  return detector.mock.calls.map(([, , sourceWidth, , x, y, w, h]) => ({
    x,
    y,
    w,
    h,
    wholeRegion: sourceWidth !== photoWidth,
  }));
}

describe('detectFaces options', () => {
  const rejected: [string, DetectFacesOptions][] = [
    ['scoreThreshold below 0', { modelPath, scoreThreshold: -0.01 }],
    ['scoreThreshold above 1', { modelPath, scoreThreshold: 1.01 }],
    ['nmsThreshold below 0', { modelPath, nmsThreshold: -0.01 }],
    ['nmsThreshold above 1', { modelPath, nmsThreshold: 1.01 }],
    ['maxInputEdge below 32', { modelPath, maxInputEdge: 31 }],
    ['an infinite maxInputEdge', { modelPath, maxInputEdge: Infinity }],
    ['tileOverlap below 0', { modelPath, tileOverlap: -0.01 }],
    ['tileOverlap of 1', { modelPath, tileOverlap: 1 }],
  ];
  it.each(rejected)('rejects %s', async (_, options) => {
    await expect(detectFaces(photo(64, 64), 64, 64, undefined, options)).rejects.toThrow(
      RangeError,
    );
  });

  const accepted: [string, DetectFacesOptions][] = [
    ['scoreThreshold of 0', { modelPath, scoreThreshold: 0 }],
    ['scoreThreshold of 1', { modelPath, scoreThreshold: 1 }],
    ['nmsThreshold of 0', { modelPath, nmsThreshold: 0 }],
    ['nmsThreshold of 1', { modelPath, nmsThreshold: 1 }],
    ['maxInputEdge of 32', { modelPath, maxInputEdge: 32 }],
    ['tileOverlap of 0', { modelPath, tileOverlap: 0 }],
    ['tileOverlap just under 1', { modelPath, tileOverlap: 0.99 }],
  ];
  it.each(accepted)('accepts %s', async (_, options) => {
    await expect(detectFaces(photo(64, 64), 64, 64, undefined, options)).resolves.toEqual([]);
  });

  it('refuses a buffer smaller than the photo', async () => {
    await expect(detectFaces(photo(64, 63), 64, 64, undefined, { modelPath })).rejects.toThrow(
      RangeError,
    );
  });

  it('only asks the detector for faces scoring 0.6 or better by default', async () => {
    await detectFaces(photo(64, 64), 64, 64, undefined, { modelPath });
    expect(detector.mock.calls[0]![8]).toBe(0.6);
  });

  it('passes a custom score threshold on', async () => {
    await detectFaces(photo(64, 64), 64, 64, undefined, { modelPath, scoreThreshold: 0.45 });
    expect(detector.mock.calls[0]![8]).toBe(0.45);
  });
});

describe('detectFaces on the whole photo', () => {
  it('scales the photo down so its long edge is at most maxInputEdge, and maps boxes back', async () => {
    detector.mockResolvedValue([candidate(32, 16, 64, 32)]);
    const [face] = await detectFaces(photo(200, 100), 200, 100, undefined, {
      modelPath,
      maxInputEdge: 100,
    });
    expect(detector.mock.calls[0]!.slice(6, 8)).toEqual([100, 50]);
    expect(face!.box).toMatchObject({ x: 0.32, y: 0.32, w: 0.64, h: 0.64 });
  });

  it('merges two boxes that overlap by an IoU of 0.3 by default', async () => {
    detector.mockResolvedValue([candidate(0, 0, 13, 10, 0.9), candidate(7, 0, 13, 10, 0.8)]);
    const faces = await detectFaces(photo(100, 100), 100, 100, undefined, { modelPath });
    expect(faces).toHaveLength(1);
    expect(faces[0]!.box.w).toBeCloseTo(0.2);
  });

  it('keeps two boxes apart when they overlap by less than the nmsThreshold', async () => {
    detector.mockResolvedValue([candidate(0, 0, 13, 10, 0.9), candidate(7, 0, 13, 10, 0.8)]);
    const faces = await detectFaces(photo(100, 100), 100, 100, undefined, {
      modelPath,
      nmsThreshold: 0.31,
    });
    expect(faces).toHaveLength(2);
  });

  it('returns at most topK faces, strongest first', async () => {
    detector.mockResolvedValue([
      candidate(0, 0, 10, 10, 0.7),
      candidate(50, 0, 10, 10, 0.9),
      candidate(0, 50, 10, 10, 0.8),
    ]);
    const faces = await detectFaces(photo(100, 100), 100, 100, undefined, { modelPath, topK: 2 });
    expect(faces.map((f) => f.score)).toEqual([0.9, 0.8]);
  });

  it('clips a box that hangs over the photo edge', async () => {
    detector.mockResolvedValue([candidate(90, 0, 20, 10)]);
    const [face] = await detectFaces(photo(100, 100), 100, 100, undefined, { modelPath });
    expect(face!.box).toMatchObject({ x: 0.9, w: 0.1 });
  });

  it('drops a box that lies entirely outside the photo', async () => {
    detector.mockResolvedValue([candidate(100, 0, 20, 10), candidate(-20, 0, 20, 10)]);
    expect(await detectFaces(photo(100, 100), 100, 100, undefined, { modelPath })).toEqual([]);
  });

  it('measures the head roll as the angle from the right eye to the left eye', async () => {
    const level = {
      ...candidate(10, 10, 20, 20),
      landmarks: [
        { x: 15, y: 20 },
        { x: 25, y: 20 },
      ],
    };
    const tilted = {
      ...candidate(60, 10, 20, 20),
      landmarks: [
        { x: 65, y: 20 },
        { x: 75, y: 30 },
      ],
    };
    detector.mockResolvedValue([level, tilted]);
    const faces = await detectFaces(photo(100, 100), 100, 100, undefined, { modelPath });
    expect(faces.map((f) => f.angle).sort()).toEqual([0, Math.PI / 4]);
  });
});

describe('detectFaces in a region', () => {
  const half = { type: 'rect', x: 0, y: 0, w: 0.5, h: 1 } as const;

  it('searches a region no wider than maxInputEdge in one tile', async () => {
    await detectFaces(photo(1280, 64), 1280, 64, half, { modelPath, tileOverlap: 0 });
    expect(lookedAt(1280)).toEqual([{ x: 0, y: 0, w: 640, h: 64, wholeRegion: false }]);
  });

  it('cuts a region wider than maxInputEdge into tiles, then looks at all of it at once', async () => {
    await detectFaces(photo(1282, 64), 1282, 64, half, { modelPath, tileOverlap: 0 });
    expect(lookedAt(1282)).toEqual([
      { x: 0, y: 0, w: 640, h: 64, wholeRegion: false },
      { x: 640, y: 0, w: 1, h: 64, wholeRegion: false },
      { x: 0, y: 0, w: 640, h: 64, wholeRegion: true },
    ]);
  });

  it('steps tiles by 80% of their size, across and down, by default', async () => {
    await detectFaces(photo(1282, 64), 1282, 64, half, { modelPath });
    expect(lookedAt(1282).filter((c) => !c.wholeRegion)).toEqual([
      { x: 0, y: 0, w: 640, h: 64, wholeRegion: false },
      { x: 512, y: 0, w: 129, h: 64, wholeRegion: false },
      { x: 0, y: 51, w: 640, h: 13, wholeRegion: false },
      { x: 512, y: 51, w: 129, h: 13, wholeRegion: false },
    ]);
  });

  it('steps tiles by what tileOverlap leaves of their size', async () => {
    await detectFaces(photo(1282, 64), 1282, 64, half, { modelPath, tileOverlap: 0.5 });
    expect(lookedAt(1282).filter((c) => !c.wholeRegion && c.y === 0)).toEqual([
      { x: 0, y: 0, w: 640, h: 64, wholeRegion: false },
      { x: 320, y: 0, w: 321, h: 64, wholeRegion: false },
      { x: 640, y: 0, w: 1, h: 64, wholeRegion: false },
    ]);
  });

  it('finds nothing in a region with no area', async () => {
    const empty = { type: 'rect', x: 0.5, y: 0, w: 0, h: 1 } as const;
    expect(await detectFaces(photo(1280, 64), 1280, 64, empty, { modelPath })).toEqual([]);
    expect(detector).not.toHaveBeenCalled();
  });
});
