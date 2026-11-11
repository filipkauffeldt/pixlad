import { beforeAll, describe, expect, it } from 'vitest';
import { actions, currentPhoto, getState } from '../src/renderer/store';

const photo = { id: 'p1', path: '/tmp/p1.jpg', name: 'p1.jpg', width: 1600, height: 1200 };
const rect = (x: number) => ({ type: 'rect' as const, x, y: 0.2, w: 0.1, h: 0.1 });

beforeAll(async () => {
  (globalThis as { window?: unknown }).window = {
    api: { addPaths: async () => ({ photos: [photo], refused: [], duplicates: 0 }) },
  };
  await actions.addPaths([photo.path]);
});

const areaXs = (): number[] =>
  currentPhoto(getState())!.areas.map((a) => (a.shape?.type === 'rect' ? a.shape.x : -1));

describe('removing one area', () => {
  it('drops just that area, counts as an edit, and Undo brings it back in place', () => {
    actions.addShape(rect(0.1), 'add');
    actions.addShape(rect(0.4), 'add');
    actions.addShape(rect(0.7), 'subtract');
    const before = currentPhoto(getState())!;

    actions.removeArea(1);
    const after = currentPhoto(getState())!;
    expect(areaXs()).toEqual([0.1, 0.7]);
    expect(after.rev).toBe(before.rev + 1);

    actions.undo();
    expect(areaXs()).toEqual([0.1, 0.4, 0.7]);
  });

  it('removes a switched-off area as well', () => {
    actions.toggleArea(0);
    actions.removeArea(0);
    expect(areaXs()).toEqual([0.4, 0.7]);
  });

  it('ignores an index that is not an area, without touching Undo', () => {
    const before = currentPhoto(getState())!;
    actions.removeArea(-1);
    actions.removeArea(2);
    expect(currentPhoto(getState())).toBe(before);
  });
});
