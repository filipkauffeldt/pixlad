import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddResult, PhotoInfo } from '../src/shared/ipc';
import type { Shape } from '../src/shared/types';

const photo = (id: string, name = `${id}.jpg`): PhotoInfo => ({
  id,
  path: `/photos/${name}`,
  name,
  width: 800,
  height: 600,
});

const rect: Shape = { type: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3 };

let api: { addPaths: ReturnType<typeof vi.fn>; removePhoto: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetModules();
  api = {
    addPaths: vi.fn(async (): Promise<AddResult> => ({ photos: [], refused: [], duplicates: 0 })),
    removePhoto: vi.fn(async () => undefined),
  };
  (globalThis as unknown as { window: unknown }).window = { api };
});

const store = () => import('../src/renderer/store');

describe('face padding', () => {
  it('gives a new photo the padding set last in the session', async () => {
    api.addPaths.mockResolvedValueOnce({ photos: [photo('a')], refused: [], duplicates: 0 });
    const { actions, getState } = await store();
    await actions.addPaths(['/photos/a.jpg']);
    actions.setFacePadding(0.3);

    api.addPaths.mockResolvedValueOnce({ photos: [photo('b')], refused: [], duplicates: 0 });
    await actions.addPaths(['/photos/b.jpg']);
    expect(getState().photos.map((p) => p.facePadding)).toEqual([0.3, 0.3]);
  });

  it('moves photos with no areas yet, but leaves photos with areas as they are', async () => {
    api.addPaths.mockResolvedValueOnce({
      photos: [photo('a'), photo('b')],
      refused: [],
      duplicates: 0,
    });
    const { actions, getState } = await store();
    await actions.addPaths(['/photos/a.jpg', '/photos/b.jpg']);
    actions.setFacePadding(0.3);

    actions.select('b');
    actions.addShape(rect, 'add');
    actions.select('a');
    actions.setFacePadding(0.4);
    const paddings = Object.fromEntries(getState().photos.map((p) => [p.info.id, p.facePadding]));
    expect(paddings).toEqual({ a: 0.4, b: 0.3 });
  });
});

describe('adding photos already in the session', () => {
  it('says how many were skipped', async () => {
    api.addPaths.mockResolvedValueOnce({ photos: [], refused: [], duplicates: 3 });
    const { actions, getState } = await store();
    await actions.addPaths(['/photos/a.jpg', '/photos/b.jpg', '/photos/c.jpg']);
    expect(getState().notices.map((n) => n.lines)).toEqual([
      ['3 photos were already in the session.'],
    ]);
  });

  it('uses the singular for one', async () => {
    api.addPaths.mockResolvedValueOnce({ photos: [], refused: [], duplicates: 1 });
    const { actions, getState } = await store();
    await actions.addPaths(['/photos/a.jpg']);
    expect(getState().notices.map((n) => n.lines)).toEqual([
      ['1 photo was already in the session.'],
    ]);
  });
});

describe('removing a photo from the session', () => {
  it('asks first when its areas have not been exported, and Keep leaves it alone', async () => {
    api.addPaths.mockResolvedValueOnce({ photos: [photo('a')], refused: [], duplicates: 0 });
    const { actions, getState } = await store();
    await actions.addPaths(['/photos/a.jpg']);
    actions.addShape(rect, 'add');

    actions.remove('a');
    expect(getState().removePhotoQuestion).toEqual({ id: 'a', name: 'a.jpg' });
    expect(getState().photos).toHaveLength(1);
    expect(api.removePhoto).not.toHaveBeenCalled();

    actions.answerRemovePhoto(false);
    expect(getState().removePhotoQuestion).toBeUndefined();
    expect(getState().photos).toHaveLength(1);
  });

  it('takes it out of the session when Remove answers the question', async () => {
    api.addPaths.mockResolvedValueOnce({ photos: [photo('a')], refused: [], duplicates: 0 });
    const { actions, getState } = await store();
    await actions.addPaths(['/photos/a.jpg']);
    actions.addShape(rect, 'add');

    actions.remove('a');
    actions.answerRemovePhoto(true);
    expect(getState().photos).toEqual([]);
    expect(api.removePhoto).toHaveBeenCalledWith('a');
  });

  it('removes a photo with nothing to lose immediately', async () => {
    api.addPaths.mockResolvedValueOnce({ photos: [photo('a')], refused: [], duplicates: 0 });
    const { actions, getState } = await store();
    await actions.addPaths(['/photos/a.jpg']);

    actions.remove('a');
    expect(getState().removePhotoQuestion).toBeUndefined();
    expect(getState().photos).toEqual([]);
    expect(api.removePhoto).toHaveBeenCalledWith('a');
  });
});
