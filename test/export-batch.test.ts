import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportOutcome, PhotoInfo } from '../src/shared/ipc';
import { actions, getState } from '../src/renderer/store';

function stubPreloadApi(exportPhoto: (id: string) => Promise<ExportOutcome>) {
  const api = {
    addPaths: vi.fn(async (paths: string[]) => ({
      photos: paths.map((path): PhotoInfo => ({
        id: path,
        path,
        name: `${path}.jpg`,
        width: 1000,
        height: 800,
      })),
      refused: [],
      duplicates: 0,
    })),
    removePhoto: vi.fn(async () => undefined),
    exportPhoto: vi.fn((id: string) => exportPhoto(id)),
    setAfterExport: vi.fn(async () => undefined),
  };
  vi.stubGlobal('window', { api });
  return api;
}

const ok = (id: string): ExportOutcome => ({
  ok: true,
  path: `/p/${id}_edit.jpg`,
  name: `${id}_edit.jpg`,
  replaced: false,
  overwrote: false,
});

async function sessionWithMosaickedPhotos(ids: string[]): Promise<void> {
  await actions.addPaths(ids);
  for (const id of ids) {
    actions.select(id);
    actions.addShape({ type: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 'add');
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(async () => {
  await actions.setAfterExport('ask').catch(() => undefined);
  if (getState().removeQuestion) actions.answerRemove(false);
  await settle();
  for (const photo of getState().photos) {
    actions.remove(photo.info.id);
    if (getState().removePhotoQuestion) actions.answerRemovePhoto(true);
  }
  vi.unstubAllGlobals();
});

describe('Export all', () => {
  it('exports every photo and reports the count', async () => {
    const api = stubPreloadApi(async (id) => ok(id));
    await sessionWithMosaickedPhotos(['a', 'b', 'c']);
    const done = actions.exportAll();
    await settle();
    actions.answerRemove(false);
    await done;
    expect(api.exportPhoto).toHaveBeenCalledTimes(3);
    expect(getState().batch).toMatchObject({ ok: 3, cancelled: 0, finished: true });
  });

  it('cancels after the photo being written: it finishes, the rest are left', async () => {
    let finishFirst!: () => void;
    const api = stubPreloadApi((id) =>
      id === 'a'
        ? new Promise((resolve) => {
            finishFirst = () => resolve(ok(id));
          })
        : Promise.resolve(ok(id)),
    );
    await sessionWithMosaickedPhotos(['a', 'b', 'c']);
    const done = actions.exportAll();
    await settle();
    expect(getState().batch).toMatchObject({ done: 0, finished: false, cancelling: false });

    actions.cancelExportAll();
    expect(getState().batch?.cancelling).toBe(true);
    finishFirst();
    await settle();
    expect(getState().removeQuestion).toEqual({ count: 1, name: 'a.jpg' });
    actions.answerRemove(true);
    await done;

    expect(api.exportPhoto).toHaveBeenCalledTimes(1);
    expect(getState().batch).toMatchObject({
      ok: 1,
      failed: [],
      cancelled: 2,
      finished: true,
    });
    expect(getState().photos.map((p) => p.info.id)).toEqual(['b', 'c']);
    expect(getState().photos.map((p) => p.status)).toEqual(['idle', 'idle']);
  });

  it('keeps photos that were exported before the cancel', async () => {
    let finishSecond!: () => void;
    stubPreloadApi((id) =>
      id === 'b'
        ? new Promise((resolve) => {
            finishSecond = () => resolve(ok(id));
          })
        : Promise.resolve(ok(id)),
    );
    await sessionWithMosaickedPhotos(['a', 'b', 'c']);
    const done = actions.exportAll();
    await settle();
    expect(getState().batch).toMatchObject({ done: 1, ok: 1 });
    actions.cancelExportAll();
    finishSecond();
    await settle();
    actions.answerRemove(false);
    await done;
    expect(getState().batch).toMatchObject({ ok: 2, cancelled: 1, finished: true });
    expect(getState().photos.map((p) => p.status)).toEqual(['exported', 'exported', 'idle']);
  });

  it('ignores Cancel when no batch is running', () => {
    stubPreloadApi(async (id) => ok(id));
    const before = getState().batch;
    actions.cancelExportAll();
    expect(getState().batch).toBe(before);
  });
});

describe('the question after an export', () => {
  async function exportOnePhoto(): Promise<void> {
    await sessionWithMosaickedPhotos(['a']);
    await actions.exportAll();
  }

  it('asks by default, and Don’t ask again saves the answer given', async () => {
    const api = stubPreloadApi(async (id) => ok(id));
    await sessionWithMosaickedPhotos(['a']);
    const done = actions.exportAll();
    await settle();
    expect(getState().removeQuestion).toEqual({ count: 1, name: 'a.jpg' });
    actions.answerRemove(true, true);
    await done;
    expect(api.setAfterExport).toHaveBeenCalledWith('remove');
    expect(getState().afterExport).toBe('remove');
    expect(getState().photos).toEqual([]);
    expect(getState().removePhotoQuestion).toBeUndefined();
  });

  it('saves Keep when that is the answer given with Don’t ask again', async () => {
    const api = stubPreloadApi(async (id) => ok(id));
    await sessionWithMosaickedPhotos(['a']);
    const done = actions.exportAll();
    await settle();
    actions.answerRemove(false, true);
    await done;
    expect(api.setAfterExport).toHaveBeenCalledWith('keep');
    expect(getState().afterExport).toBe('keep');
    expect(getState().photos).toHaveLength(1);
  });

  it('saves nothing when Don’t ask again is not ticked', async () => {
    const api = stubPreloadApi(async (id) => ok(id));
    await sessionWithMosaickedPhotos(['a']);
    const done = actions.exportAll();
    await settle();
    actions.answerRemove(true);
    await done;
    expect(api.setAfterExport).not.toHaveBeenCalled();
    expect(getState().afterExport).toBe('ask');
  });

  it('keeps the photos without asking when set to keep', async () => {
    stubPreloadApi(async (id) => ok(id));
    await actions.setAfterExport('keep');
    await exportOnePhoto();
    expect(getState().removeQuestion).toBeUndefined();
    expect(getState().photos.map((p) => p.status)).toEqual(['exported']);
  });

  it('removes the exported photos without asking when set to remove', async () => {
    stubPreloadApi(async (id) => ok(id));
    await actions.setAfterExport('remove');
    await exportOnePhoto();
    expect(getState().removeQuestion).toBeUndefined();
    expect(getState().removePhotoQuestion).toBeUndefined();
    expect(getState().photos).toEqual([]);
  });

  it('still leaves out a photo edited after its export when set to remove', async () => {
    const editDuringExport = (): void => {
      actions.addShape({ type: 'rect', x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, 'add');
    };
    stubPreloadApi(async (id) => {
      editDuringExport();
      return ok(id);
    });
    await actions.setAfterExport('remove');
    await exportOnePhoto();
    expect(getState().photos.map((p) => p.info.id)).toEqual(['a']);
    expect(getState().removePhotoQuestion).toBeUndefined();
  });
});
