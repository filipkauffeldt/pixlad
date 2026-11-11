import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoInfo } from '../src/shared/ipc';
import type { Rect } from '../src/shared/types';
import { actions, currentPhoto, getState, type PhotoState } from '../src/renderer/store';

const api = {
  addPaths: vi.fn(),
  exportPhoto: vi.fn(),
};
(globalThis as { window?: unknown }).window = { api };

let counter = 0;
/** Puts one fresh photo in the session and makes it the current one. */
async function addPhoto(): Promise<PhotoInfo> {
  const info = {
    id: `photo-${++counter}`,
    name: `p${counter}.jpg`,
    width: 1600,
    height: 1200,
  } as PhotoInfo;
  api.addPaths.mockResolvedValueOnce({ photos: [info], refused: [], duplicates: 0 });
  await actions.addPaths([info.name]);
  actions.select(info.id);
  return info;
}

const rect = (x: number): Rect => ({ type: 'rect', x, y: 0.2, w: 0.1, h: 0.1 });
const draw = (x: number): void => actions.addShape(rect(x), 'add');
const photo = (): PhotoState => currentPhoto(getState())!;
const xs = (): number[] => photo().areas.map((a) => (a.shape as Rect).x);

beforeEach(() => {
  api.addPaths.mockReset();
  api.exportPhoto.mockReset();
});

describe('redo', () => {
  it('has nothing to redo until something was undone', async () => {
    await addPhoto();
    draw(0.1);
    expect(photo().redo).toHaveLength(0);
    actions.redo();
    expect(xs()).toEqual([0.1]);
  });

  it('brings back what undo took off, one step at a time', async () => {
    await addPhoto();
    draw(0.1);
    draw(0.3);
    actions.undo();
    actions.undo();
    expect(xs()).toEqual([]);
    expect(photo().redo).toHaveLength(2);
    actions.redo();
    expect(xs()).toEqual([0.1]);
    actions.redo();
    expect(xs()).toEqual([0.1, 0.3]);
    expect(photo().redo).toHaveLength(0);
    actions.undo();
    expect(xs()).toEqual([0.1]);
  });

  it('is cleared by a new edit', async () => {
    await addPhoto();
    draw(0.1);
    actions.undo();
    draw(0.5);
    expect(photo().redo).toHaveLength(0);
    actions.redo();
    expect(xs()).toEqual([0.5]);
  });

  it('is cleared by Reset, and Undo then brings the areas back', async () => {
    await addPhoto();
    draw(0.1);
    draw(0.3);
    actions.undo();
    expect(photo().redo).toHaveLength(1);
    actions.reset();
    expect(photo().areas).toHaveLength(0);
    expect(photo().redo).toHaveLength(0);
    actions.undo();
    expect(xs()).toEqual([0.1]);
  });

  it('is kept when only the block size or padding changes', async () => {
    await addPhoto();
    draw(0.1);
    actions.undo();
    actions.setBlockPx(photo().blockPx + 1);
    actions.setFacePadding(0.3);
    expect(photo().redo).toHaveLength(1);
  });

  it('keeps each photo its own stack', async () => {
    const first = await addPhoto();
    draw(0.1);
    actions.undo();
    await addPhoto();
    expect(photo().redo).toHaveLength(0);
    actions.select(first.id);
    expect(photo().redo).toHaveLength(1);
  });

  it('stops undo at 50 steps and keeps the same limit going forward', async () => {
    await addPhoto();
    for (let i = 0; i < 60; i++) draw(i / 100);
    expect(photo().undo).toHaveLength(50);
    for (let i = 0; i < 50; i++) actions.undo();
    expect(photo().redo).toHaveLength(50);
    for (let i = 0; i < 50; i++) actions.redo();
    expect(photo().undo).toHaveLength(50);
    expect(xs()).toHaveLength(60);
  });

  it('is cleared when an export replaces the original', async () => {
    await addPhoto();
    draw(0.1);
    draw(0.3);
    actions.undo();
    expect(photo().redo).toHaveLength(1);
    api.exportPhoto.mockResolvedValueOnce({ ok: true, overwrote: true, name: 'a.jpg' });
    await actions.exportPhoto(photo().info.id);
    expect(photo().undo).toHaveLength(0);
    expect(photo().redo).toHaveLength(0);
  });

  it('survives an export to a new copy', async () => {
    await addPhoto();
    draw(0.1);
    draw(0.3);
    actions.undo();
    api.exportPhoto.mockResolvedValueOnce({ ok: true, overwrote: false, name: 'a_edit.jpg' });
    await actions.exportPhoto(photo().info.id);
    expect(photo().redo).toHaveLength(1);
  });
});
