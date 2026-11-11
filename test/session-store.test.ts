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
