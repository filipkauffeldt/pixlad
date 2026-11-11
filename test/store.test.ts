import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoInfo } from '../src/shared/ipc';
import type { Rect } from '../src/shared/types';
import { actions, currentPhoto, getState, type PhotoState } from '../src/renderer/store';

const api = {
  addPaths: vi.fn(),
  exportPhoto: vi.fn(),
  detect: vi.fn(),
  removePhoto: vi.fn(),
};
(globalThis as { window?: unknown }).window = { api };
// A failed detection is reported as an event on the document.
const events = new EventTarget();
(globalThis as { document?: unknown }).document = events;

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
  api.detect.mockReset();
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

const face = (x: number, score = 0.9) => ({
  box: { type: 'rect', x, y: 0.3, w: 0.1, h: 0.1 },
  score,
});
const faceAreas = (): { mode: string; enabled: boolean }[] =>
  photo().areas.filter((a) => a.kind === 'face');

describe('finding all faces', () => {
  it('runs the detector over the whole photo and adds each face like Faces + Add', async () => {
    await addPhoto();
    api.detect.mockResolvedValueOnce([face(0.1), face(0.5)]);
    await actions.findAllFaces();
    expect(api.detect).toHaveBeenCalledWith(photo().info.id, {
      type: 'rect',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
    expect(faceAreas()).toEqual([
      expect.objectContaining({ mode: 'add', enabled: true }),
      expect.objectContaining({ mode: 'add', enabled: true }),
    ]);
    expect(photo().undo).toHaveLength(1); // one step for both faces
  });

  it('adds with mosaic even while the Subtract mode is picked, as a drag would not', async () => {
    await addPhoto();
    actions.setMode('subtract');
    api.detect.mockResolvedValueOnce([face(0.2)]);
    await actions.findAllFaces();
    expect(faceAreas()).toEqual([expect.objectContaining({ mode: 'add' })]);
    actions.setMode('add');
  });

  it('does not add a face that is already there', async () => {
    await addPhoto();
    api.detect.mockResolvedValue([face(0.1)]);
    await actions.findAllFaces();
    await actions.findAllFaces();
    expect(faceAreas()).toHaveLength(1);
  });

  it('is busy while the detector runs, and ignores a second call', async () => {
    await addPhoto();
    let finish!: (faces: unknown[]) => void;
    api.detect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const first = actions.findAllFaces();
    expect(getState().detecting).toBe(true);
    await actions.findAllFaces();
    expect(api.detect).toHaveBeenCalledTimes(1);
    finish([face(0.1)]);
    await first;
    expect(getState().detecting).toBe(false);
  });

  it('adds the faces to the photo it was started on, even if another is shown by then', async () => {
    const first = await addPhoto();
    let finish!: (faces: unknown[]) => void;
    api.detect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const running = actions.findAllFaces();
    await addPhoto();
    finish([face(0.1)]);
    await running;
    expect(photo().areas).toHaveLength(0);
    actions.select(first.id);
    expect(faceAreas()).toHaveLength(1);
  });

  it('does nothing without a photo', async () => {
    while (getState().currentId) {
      actions.remove(getState().currentId!);
      actions.answerRemovePhoto(true); // photos with unexported areas ask first
    }
    await actions.findAllFaces();
    expect(api.detect).not.toHaveBeenCalled();
    expect(getState().detecting).toBe(false);
  });

  it('says so where it looked when no face is found, and reports a failure', async () => {
    await addPhoto();
    const failures: string[] = [];
    events.addEventListener('pixlad:detect-failed', (e) =>
      failures.push((e as CustomEvent).detail),
    );
    api.detect.mockResolvedValueOnce([]);
    await actions.findAllFaces();
    expect(getState().noFaces).toEqual({ photoId: photo().info.id, shape: undefined });
    expect(getState().notices).toHaveLength(0);
    api.detect.mockRejectedValueOnce(new Error('model missing'));
    await actions.findAllFaces();
    expect(failures).toEqual(['model missing']);
    expect(getState().detecting).toBe(false);
    expect(faceAreas()).toHaveLength(0);
  });

  it('leaves the stage to label the whole photo instead of outlining all of it', async () => {
    await addPhoto();
    let finish!: (faces: unknown[]) => void;
    api.detect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const running = actions.findAllFaces();
    expect(getState().detectRegion).toEqual({ photoId: photo().info.id, shape: undefined });
    finish([]);
    await running;
    expect(getState().detectRegion).toBeUndefined();
  });

  it('hands the dragged region, or the lasso outline, to the stage', async () => {
    await addPhoto();
    const region: Rect = { type: 'rect', x: 0, y: 0, w: 0.3, h: 1 };
    let finish!: (faces: unknown[]) => void;
    api.detect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const dragged = actions.detectFaces(photo().info.id, region);
    expect(getState().detectRegion?.shape).toEqual(region);
    finish([]);
    await dragged;

    const lasso = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0 },
      { x: 0.3, y: 1 },
    ];
    api.detect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const outlined = actions.detectFaces(photo().info.id, region, lasso);
    expect(getState().detectRegion?.shape).toEqual({ type: 'polygon', points: lasso });
    finish([]);
    await outlined;
  });

  it('keeps only faces inside a lasso when one is given', async () => {
    await addPhoto();
    const lasso = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0 },
      { x: 0.3, y: 1 },
      { x: 0, y: 1 },
    ];
    api.detect.mockResolvedValueOnce([face(0.1), face(0.6)]);
    await actions.detectFaces(photo().info.id, { type: 'rect', x: 0, y: 0, w: 0.3, h: 1 }, lasso);
    expect(faceAreas()).toHaveLength(1);
  });
});
