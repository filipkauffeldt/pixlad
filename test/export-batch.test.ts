import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportOutcome, PhotoInfo } from '../src/shared/ipc';
import { actions, getState } from '../src/renderer/store';

/** The renderer's store with a stand-in for what the preload exposes. */
function stubApi(exportPhoto: (id: string) => Promise<ExportOutcome>) {
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

/** Add photos that each carry a mosaic. */
async function sessionWith(ids: string[]): Promise<void> {
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
  // Leave the shared store empty for the next test.
  if (getState().removeQuestion) actions.answerRemove(false);
  await settle();
  for (const photo of getState().photos) {
    actions.remove(photo.info.id);
    // A photo with unexported areas asks first; the answer here is yes.
    if (getState().removePhotoQuestion) actions.answerRemovePhoto(true);
  }
  vi.unstubAllGlobals();
});

describe('Export all', () => {
  it('exports every photo and reports the count', async () => {
    const api = stubApi(async (id) => ok(id));
    await sessionWith(['a', 'b', 'c']);
    const done = actions.exportAll();
    await settle();
    actions.answerRemove(false);
    await done;
    expect(api.exportPhoto).toHaveBeenCalledTimes(3);
    expect(getState().batch).toMatchObject({ ok: 3, cancelled: 0, finished: true });
  });

  it('cancels after the photo being written: it finishes, the rest are left', async () => {
    let finishFirst!: () => void;
    const api = stubApi((id) =>
      id === 'a'
        ? new Promise((resolve) => {
            finishFirst = () => resolve(ok(id));
          })
        : Promise.resolve(ok(id)),
    );
    await sessionWith(['a', 'b', 'c']);
    const done = actions.exportAll();
    await settle();
    expect(getState().batch).toMatchObject({ done: 0, finished: false, cancelling: false });

    actions.cancelExportAll();
    expect(getState().batch?.cancelling).toBe(true);
    finishFirst();
    await settle();
    // The removal question covers the one photo that was exported.
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
    stubApi((id) =>
      id === 'b'
        ? new Promise((resolve) => {
            finishSecond = () => resolve(ok(id));
          })
        : Promise.resolve(ok(id)),
    );
    await sessionWith(['a', 'b', 'c']);
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
    stubApi(async (id) => ok(id));
    const before = getState().batch;
    actions.cancelExportAll();
    expect(getState().batch).toBe(before);
  });
});

describe('the question after an export', () => {
  /** Export one photo and return what the app asked, if it did. */
  async function exportOne(): Promise<void> {
    await sessionWith(['a']);
    await actions.exportAll();
  }

  it('asks by default, and Don’t ask again saves the answer given', async () => {
    const api = stubApi(async (id) => ok(id));
    await sessionWith(['a']);
    const done = actions.exportAll();
    await settle();
    expect(getState().removeQuestion).toEqual({ count: 1, name: 'a.jpg' });
    actions.answerRemove(true, true);
    await done;
    expect(api.setAfterExport).toHaveBeenCalledWith('remove');
    expect(getState().afterExport).toBe('remove');
    expect(getState().photos).toEqual([]);
    // The photos were exported, so removing them loses nothing and does not ask.
    expect(getState().removePhotoQuestion).toBeUndefined();
  });

  it('saves Keep when that is the answer given with Don’t ask again', async () => {
    const api = stubApi(async (id) => ok(id));
    await sessionWith(['a']);
    const done = actions.exportAll();
    await settle();
    actions.answerRemove(false, true);
    await done;
    expect(api.setAfterExport).toHaveBeenCalledWith('keep');
    expect(getState().afterExport).toBe('keep');
    expect(getState().photos).toHaveLength(1);
  });

  it('saves nothing when Don’t ask again is not ticked', async () => {
    const api = stubApi(async (id) => ok(id));
    await sessionWith(['a']);
    const done = actions.exportAll();
    await settle();
    actions.answerRemove(true);
    await done;
    expect(api.setAfterExport).not.toHaveBeenCalled();
    expect(getState().afterExport).toBe('ask');
  });

  it('keeps the photos without asking when set to keep', async () => {
    stubApi(async (id) => ok(id));
    await actions.setAfterExport('keep');
    await exportOne();
    expect(getState().removeQuestion).toBeUndefined();
    expect(getState().photos.map((p) => p.status)).toEqual(['exported']);
  });

  it('removes the exported photos without asking when set to remove', async () => {
    stubApi(async (id) => ok(id));
    await actions.setAfterExport('remove');
    await exportOne();
    expect(getState().removeQuestion).toBeUndefined();
    expect(getState().removePhotoQuestion).toBeUndefined();
    expect(getState().photos).toEqual([]);
  });

  it('still leaves out a photo edited after its export when set to remove', async () => {
    stubApi(async (id) => {
      // Drawn while the export runs.
      actions.addShape({ type: 'rect', x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, 'add');
      return ok(id);
    });
    await actions.setAfterExport('remove');
    await exportOne();
    expect(getState().photos.map((p) => p.info.id)).toEqual(['a']);
    // Leaving it out is not asking: the question about losing edits never opens by itself.
    expect(getState().removePhotoQuestion).toBeUndefined();
  });
});
