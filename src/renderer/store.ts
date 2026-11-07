import { useSyncExternalStore } from 'react';
import { defaultBlockPx } from '../shared/block-size';
import type { ExportTarget, PhotoInfo } from '../shared/ipc';
import { opHasAddedArea, type Rect, type Shape } from '../shared/types';
import {
  opFromAreas,
  withDetectedFaces,
  withoutFacesInside,
  type RetouchArea,
  type RetouchMode,
} from './retouch';

export type Tool = 'faces' | 'rect' | 'lasso';
export type ExportStatus = 'idle' | 'exporting' | 'exported' | 'failed';

export interface PhotoState {
  info: PhotoInfo;
  areas: RetouchArea[];
  undo: RetouchArea[][];
  blockPx: number;
  facePadding: number;
  /** Bumped by every change that alters the mosaic. */
  rev: number;
  /** The `rev` the last successful export was made from. */
  exportedRev: number;
  status: ExportStatus;
  message?: string;
  /** Bumped when the file on disk was overwritten, so the image and thumbnail load again. */
  fileVersion: number;
}

export interface Notice {
  id: number;
  lines: string[];
  kind: 'info' | 'error';
}

export interface AppState {
  photos: PhotoState[];
  currentId: string | undefined;
  tool: Tool;
  mode: RetouchMode;
  detecting: boolean;
  adding: boolean;
  notices: Notice[];
  toasts: Notice[];
  batch:
    { done: number; total: number; failed: string[]; finished: boolean; ok: number } | undefined;
  dragging: boolean;
  exportTarget: ExportTarget;
}

const initial: AppState = {
  photos: [],
  currentId: undefined,
  tool: 'faces',
  mode: 'add',
  detecting: false,
  adding: false,
  notices: [],
  toasts: [],
  batch: undefined,
  dragging: false,
  exportTarget: 'suffix',
};

let state = initial;
const listeners = new Set<() => void>();
let noticeId = 0;

const set = (next: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void => {
  state = { ...state, ...(typeof next === 'function' ? next(state) : next) };
  listeners.forEach((l) => l());
};

export const getState = (): AppState => state;
export const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useApp = (): AppState => useSyncExternalStore(subscribe, getState, getState);

export const longEdgeOf = (p: PhotoState): number => Math.max(p.info.width, p.info.height);
export const opOf = (p: PhotoState) =>
  opFromAreas(p.areas, p.blockPx, p.facePadding, longEdgeOf(p));
export const hasMosaic = (p: PhotoState): boolean => opHasAddedArea(opOf(p));
export const isUnexported = (p: PhotoState): boolean => hasMosaic(p) && p.exportedRev !== p.rev;
export const unexportedCount = (s: AppState): number => s.photos.filter(isUnexported).length;
export const currentPhoto = (s: AppState): PhotoState | undefined =>
  s.photos.find((p) => p.info.id === s.currentId);

const updatePhoto = (id: string, fn: (p: PhotoState) => PhotoState): void =>
  set((s) => ({ photos: s.photos.map((p) => (p.info.id === id ? fn(p) : p)) }));

/** An edit to the areas: remembered for Undo, bumps the revision. */
const editAreas = (id: string, fn: (areas: RetouchArea[]) => RetouchArea[]): void =>
  updatePhoto(id, (p) => {
    const areas = fn(p.areas);
    if (areas === p.areas) return p;
    return { ...p, areas, undo: [...p.undo.slice(-49), p.areas], rev: p.rev + 1 };
  });

const notify = (lines: string[], kind: Notice['kind'] = 'info'): void =>
  set((s) => ({ notices: [...s.notices, { id: ++noticeId, lines, kind }] }));
const toast = (lines: string[]): void =>
  set((s) => ({ toasts: [...s.toasts, { id: ++noticeId, lines, kind: 'error' }] }));

const newPhoto = (info: PhotoInfo): PhotoState => ({
  info,
  areas: [],
  undo: [],
  blockPx: defaultBlockPx(Math.max(info.width, info.height)),
  facePadding: 0.15,
  rev: 0,
  exportedRev: 0,
  status: 'idle',
  fileVersion: 0,
});

let removalPrompts: Promise<void> = Promise.resolve();

/**
 * Ask whether to take these exported photos out of the session. One question at a time, and a
 * photo edited since its export is left out: removing it would lose that edit.
 */
const offerRemoval = (ids: readonly string[]): Promise<void> => {
  const removable = (): PhotoState[] =>
    state.photos.filter((p) => ids.includes(p.info.id) && !isUnexported(p));
  removalPrompts = removalPrompts
    .then(async () => {
      const offered = removable();
      if (offered.length === 0) return;
      const name = offered.length === 1 ? offered[0]!.info.name : undefined;
      if (await window.api.confirmRemoveExported(offered.length, name)) {
        for (const photo of removable()) actions.remove(photo.info.id);
      }
    })
    .catch((cause: unknown) => {
      notify([`Could not ask about removing: ${errorText(cause)}`], 'error');
    });
  return removalPrompts;
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const actions = {
  setDragging: (dragging: boolean): void => set({ dragging }),
  setTool: (tool: Tool): void => set({ tool }),
  setMode: (mode: RetouchMode): void => set({ mode }),
  dismissNotice: (id: number): void =>
    set((s) => ({
      notices: s.notices.filter((n) => n.id !== id),
      toasts: s.toasts.filter((n) => n.id !== id),
    })),

  async openDialog(): Promise<void> {
    const paths = await window.api.openDialog();
    if (paths.length > 0) await actions.addPaths(paths);
  },

  /** Add dropped files and folders. In chunks, so the window stays responsive for hundreds. */
  async addPaths(paths: string[]): Promise<void> {
    set({ adding: true });
    const refused: string[] = [];
    let duplicates = 0;
    try {
      for (let i = 0; i < paths.length; i += 25) {
        const result = await window.api.addPaths(paths.slice(i, i + 25));
        duplicates += result.duplicates;
        for (const r of result.refused) refused.push(`"${r.name}" ${r.reason}.`);
        if (result.photos.length > 0) {
          set((s) => ({
            photos: [...s.photos, ...result.photos.map(newPhoto)],
            currentId: s.currentId ?? result.photos[0]!.id,
          }));
        }
      }
    } catch (cause) {
      refused.push(
        `Could not add the files: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      set({ adding: false });
    }
    void duplicates;
    if (refused.length > 0) {
      const shown = refused.slice(0, 8);
      if (refused.length > 8) shown.push(`…and ${refused.length - 8} more.`);
      notify(shown, 'error');
    }
  },

  select(id: string): void {
    if (state.photos.some((p) => p.info.id === id)) set({ currentId: id });
  },

  step(direction: 1 | -1): void {
    const index = state.photos.findIndex((p) => p.info.id === state.currentId);
    const next = state.photos[index + direction];
    if (next) set({ currentId: next.info.id });
  },

  /** Remove from the session only; the file is never touched. */
  remove(id: string): void {
    const index = state.photos.findIndex((p) => p.info.id === id);
    if (index < 0) return;
    void window.api.removePhoto(id);
    set((s) => {
      const photos = s.photos.filter((p) => p.info.id !== id);
      const currentId =
        s.currentId === id
          ? (photos[Math.min(index, photos.length - 1)]?.info.id ?? undefined)
          : s.currentId;
      return { photos, currentId };
    });
  },

  addShape(shape: Shape, mode: RetouchMode): void {
    const id = state.currentId;
    if (!id) return;
    editAreas(id, (areas) => [
      ...areas,
      { kind: shape.type === 'rect' ? 'rect' : 'lasso', mode, enabled: true, shape },
    ]);
  },

  toggleArea(index: number): void {
    const id = state.currentId;
    if (!id) return;
    editAreas(id, (areas) =>
      areas.map((a, i) => (i === index ? { ...a, enabled: !a.enabled } : a)),
    );
  },

  removeFacesInside(region: Shape): void {
    const id = state.currentId;
    if (!id) return;
    editAreas(id, (areas) => {
      const next = withoutFacesInside(areas, region);
      return next.length === areas.length ? areas : next;
    });
  },

  addFaces(id: string, faces: { box: Rect; score?: number }[], mode: RetouchMode): void {
    editAreas(id, (areas) => {
      const next = withDetectedFaces(areas, faces, mode);
      return next.length === areas.length ? areas : next;
    });
  },

  setDetecting: (detecting: boolean): void => set({ detecting }),
  notice: (lines: string[], kind: Notice['kind'] = 'info'): void => notify(lines, kind),

  undo(): void {
    const id = state.currentId;
    if (!id) return;
    updatePhoto(id, (p) => {
      const previous = p.undo[p.undo.length - 1];
      if (!previous) return p;
      return { ...p, areas: previous, undo: p.undo.slice(0, -1), rev: p.rev + 1 };
    });
  },

  setBlockPx(px: number): void {
    const id = state.currentId;
    if (id) updatePhoto(id, (p) => (p.blockPx === px ? p : { ...p, blockPx: px, rev: p.rev + 1 }));
  },

  setFacePadding(value: number): void {
    const id = state.currentId;
    if (id)
      updatePhoto(id, (p) =>
        p.facePadding === value ? p : { ...p, facePadding: value, rev: p.rev + 1 },
      );
  },

  /** Export one photo from what is on screen right now. */
  async exportPhoto(id: string, quiet = false): Promise<boolean> {
    const photo = state.photos.find((p) => p.info.id === id);
    if (!photo || !hasMosaic(photo)) return false;
    const rev = photo.rev;
    const op = opOf(photo);
    const exportedAreas = photo.areas;
    updatePhoto(id, (p) => ({ ...p, status: 'exporting', message: 'Exporting…' }));
    const result = await window.api.exportPhoto(id, op);
    if (result.ok && result.overwrote) {
      // The file now holds these areas and they cannot be taken out again, so they stop being
      // edits. Only what was drawn while the export ran is still to be exported.
      updatePhoto(id, (p) => {
        const areas = p.areas.filter((area) => !exportedAreas.includes(area));
        const nextRev = p.rev + 1;
        return {
          ...p,
          areas,
          undo: [],
          rev: nextRev,
          exportedRev: areas.length === 0 ? nextRev : p.exportedRev,
          status: 'exported',
          fileVersion: p.fileVersion + 1,
          message: `Saved over ${result.name}`,
        };
      });
    } else if (result.ok) {
      updatePhoto(id, (p) => ({
        ...p,
        status: 'exported',
        exportedRev: rev,
        message: `Saved as ${result.name}${result.replaced ? ' (replaced the earlier export)' : ''}`,
      }));
    } else {
      updatePhoto(id, (p) => ({ ...p, status: 'failed', message: result.message }));
      if (!quiet) toast([result.message]);
    }
    return result.ok;
  },

  async exportCurrent(): Promise<void> {
    const id = state.currentId;
    if (!id || currentPhoto(state)?.status === 'exporting') return;
    if (await actions.exportPhoto(id)) await offerRemoval([id]);
  },

  async loadSettings(): Promise<void> {
    set({ exportTarget: await window.api.exportTarget() });
  },

  async setExportTarget(exportTarget: ExportTarget): Promise<void> {
    set({ exportTarget });
    try {
      await window.api.setExportTarget(exportTarget);
    } catch (cause) {
      notify([`The setting applies now but could not be saved: ${errorText(cause)}`], 'error');
    }
  },

  /** Every photo with a mosaic, one after the other, in the background. */
  async exportAll(): Promise<void> {
    if (state.batch && !state.batch.finished) return;
    const ids = state.photos.filter(hasMosaic).map((p) => p.info.id);
    if (ids.length === 0) return;
    set({ batch: { done: 0, total: ids.length, failed: [], finished: false, ok: 0 } });
    const exported: string[] = [];
    for (const id of ids) {
      const photo = state.photos.find((p) => p.info.id === id);
      const name = photo?.info.name ?? id;
      let ok = false;
      if (photo && hasMosaic(photo)) ok = await actions.exportPhoto(id, true);
      if (ok) exported.push(id);
      else if (!photo) {
        set((s) => ({ batch: s.batch && { ...s.batch, total: s.batch.total - 1 } }));
        continue;
      }
      set((s) => ({
        batch: s.batch && {
          ...s.batch,
          done: s.batch.done + 1,
          ok: s.batch.ok + (ok ? 1 : 0),
          failed: ok ? s.batch.failed : [...s.batch.failed, name],
        },
      }));
    }
    set((s) => ({ batch: s.batch && { ...s.batch, finished: true } }));
    const batch = state.batch;
    if (batch && batch.failed.length > 0) {
      toast([`${batch.ok} exported, ${batch.failed.length} failed:`, ...batch.failed]);
    }
    await offerRemoval(exported);
  },
};
