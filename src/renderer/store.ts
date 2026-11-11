// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useSyncExternalStore } from 'react';
import { defaultBlockPx } from '../shared/block-size';
import type { ExportTarget, PhotoInfo } from '../shared/ipc';
import type { ReleaseNote } from '../shared/update';
import { opHasAddedArea, type Rect, type Shape } from '../shared/types';
import {
  opFromAreas,
  withDetectedFaces,
  withoutFacesInside,
  type RetouchArea,
  type Outline,
  type RetouchMode,
} from './retouch';

/** What a drag acts on: faces found inside it, or the drawn area itself. */
export type Target = 'faces' | 'area';
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

/** The update the app knows about, and how far along it is. */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number | undefined }
  /** Windows and Fedora: downloaded, and the app can restart into it. */
  | { phase: 'ready'; version: string }
  /** macOS: the disk image is in Downloads and open. */
  | { phase: 'opened'; version: string; fileName: string }
  | { phase: 'failed'; version: string; message: string };

/** What the About dialog says about its last "Check for updates", when no update is known. */
export type AboutCheck =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'up-to-date' }
  | { phase: 'error'; message: string };

export interface DetectRegion {
  photoId: string | undefined;
  shape: Shape | undefined;
}

export interface AppState {
  photos: PhotoState[];
  currentId: string | undefined;
  target: Target;
  outline: Outline;
  mode: RetouchMode;
  detecting: boolean;
  /** What the detector is looking at, so the stage can keep it in view. No shape: the whole photo. */
  detectRegion: DetectRegion | undefined;
  /** "No faces found", kept for a couple of seconds where the detector looked. */
  noFaces: DetectRegion | undefined;
  adding: boolean;
  notices: Notice[];
  toasts: Notice[];
  batch:
    { done: number; total: number; failed: string[]; finished: boolean; ok: number } | undefined;
  dragging: boolean;
  exportTarget: ExportTarget;
  /** Whether the user has picked an export target. Until then the first export asks. */
  exportChosen: boolean;
  /** The first-export choice, open under the Export or the Export all button. */
  exportChoice: { anchor: 'export' | 'all' } | undefined;
  /** A photo whose unexported areas are about to be lost, waiting for an answer. */
  removePhotoQuestion: { id: string; name: string } | undefined;
  /** The Replace original confirmation, open for one photo or for every photo with a mosaic. */
  overwriteConfirm: { anchor: 'export' | 'all' } | undefined;
  /** False once the user ticked "Don't ask again this session". Never saved, so a restart asks. */
  overwriteAsk: boolean;
  checkForUpdates: boolean;
  aboutOpen: boolean;
  update: UpdateState;
  /** The user chose Later, so the prompt stays away until something new happens. */
  updatePromptHidden: boolean;
  /** What changed in the update, when GitHub has a list to show. */
  updateNotes: ReleaseNote[] | undefined;
  notesOpen: boolean;
  aboutCheck: AboutCheck;
  /** The question after an export: take these photos out of the session? */
  removeQuestion: { count: number; name: string | undefined } | undefined;
}

const initial: AppState = {
  photos: [],
  currentId: undefined,
  target: 'faces',
  outline: 'rect',
  mode: 'add',
  detecting: false,
  detectRegion: undefined,
  noFaces: undefined,
  adding: false,
  notices: [],
  toasts: [],
  batch: undefined,
  dragging: false,
  exportTarget: 'suffix',
  // True until the settings load, so an export started before that never asks twice.
  exportChosen: true,
  exportChoice: undefined,
  removePhotoQuestion: undefined,
  overwriteConfirm: undefined,
  overwriteAsk: true,
  checkForUpdates: true,
  aboutOpen: false,
  update: { phase: 'idle' },
  updatePromptHidden: false,
  updateNotes: undefined,
  notesOpen: false,
  aboutCheck: { phase: 'idle' },
  removeQuestion: undefined,
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

/** Replace original asks before it writes over a file, unless it was just confirmed or silenced. */
const needsOverwriteConfirm = (confirmed: boolean): boolean =>
  !confirmed && state.exportTarget === 'overwrite' && state.overwriteAsk;

/** An edit to the areas: remembered for Undo, bumps the revision. */
const editAreas = (id: string, fn: (areas: RetouchArea[]) => RetouchArea[]): void =>
  updatePhoto(id, (p) => {
    const areas = fn(p.areas);
    if (areas === p.areas) return p;
    return { ...p, areas, undo: [...p.undo.slice(-49), p.areas], rev: p.rev + 1 };
  });

const INFO_NOTICE_MS = 8000;
let infoNoticeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Errors stay until dismissed. An info notice replaces the previous one and clears itself after a
 * few seconds, so repeating the same action never stacks a pile of identical messages.
 */
const notify = (lines: string[], kind: Notice['kind'] = 'info'): void => {
  const id = ++noticeId;
  if (kind !== 'info') {
    set((s) => ({ notices: [...s.notices, { id, lines, kind }] }));
    return;
  }
  clearTimeout(infoNoticeTimer);
  set((s) => ({
    notices: [...s.notices.filter((n) => n.kind !== 'info'), { id, lines, kind }],
  }));
  infoNoticeTimer = setTimeout(() => actions.dismissNotice(id), INFO_NOTICE_MS);
};
const NO_FACES_MS = 2000;
let noFacesTimer: ReturnType<typeof setTimeout> | undefined;

const toast = (lines: string[]): void =>
  set((s) => ({ toasts: [...s.toasts, { id: ++noticeId, lines, kind: 'error' }] }));

/** The padding the user chose last. New photos start with it, for this session only. */
let lastFacePadding = 0.15;

const newPhoto = (info: PhotoInfo): PhotoState => ({
  info,
  areas: [],
  undo: [],
  blockPx: defaultBlockPx(Math.max(info.width, info.height)),
  facePadding: lastFacePadding,
  rev: 0,
  exportedRev: 0,
  status: 'idle',
  fileVersion: 0,
});

let startupCheckDone = false;

let removalPrompts: Promise<void> = Promise.resolve();
let answerRemoveQuestion: ((remove: boolean) => void) | undefined;

/** Show the remove question and wait for the answer. */
const askRemove = (count: number, name: string | undefined): Promise<boolean> =>
  new Promise((resolve) => {
    answerRemoveQuestion = (remove) => {
      answerRemoveQuestion = undefined;
      set({ removeQuestion: undefined });
      resolve(remove);
    };
    set({ removeQuestion: { count, name } });
  });

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
      if (await askRemove(offered.length, name)) {
        for (const photo of removable()) actions.remove(photo.info.id);
      }
    })
    .catch((cause: unknown) => {
      notify([`Could not remove the exported photos: ${errorText(cause)}`], 'error');
    });
  return removalPrompts;
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Take a photo out of the session, keeping the current photo near where it was. */
const removeNow = (id: string): void => {
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
};

export const actions = {
  setDragging: (dragging: boolean): void => set({ dragging }),
  setAboutOpen: (aboutOpen: boolean): void => set({ aboutOpen }),
  setTarget: (target: Target): void => set({ target }),
  setOutline: (outline: Outline): void => set({ outline }),
  /** The answer to the remove question: true takes the photos out of the session. */
  answerRemove: (remove: boolean): void => answerRemoveQuestion?.(remove),
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
    if (duplicates > 0) {
      notify([
        duplicates === 1
          ? '1 photo was already in the session.'
          : `${duplicates} photos were already in the session.`,
      ]);
    }
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

  /** Remove from the session only; the file is never touched. Asks first if work would be lost. */
  remove(id: string): void {
    const photo = state.photos.find((p) => p.info.id === id);
    if (!photo) return;
    if (isUnexported(photo)) {
      set({ removePhotoQuestion: { id, name: photo.info.name } });
      return;
    }
    removeNow(id);
  },

  /** The answer to "Remove <name> from the session?": true removes it, false keeps it. */
  answerRemovePhoto(remove: boolean): void {
    const question = state.removePhotoQuestion;
    set({ removePhotoQuestion: undefined });
    if (remove && question) removeNow(question.id);
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

  /** The detector starts on `region` (none: the whole photo) or stops. */
  setDetecting(detecting: boolean, region?: Shape): void {
    if (!detecting) {
      set({ detecting, detectRegion: undefined });
      return;
    }
    clearTimeout(noFacesTimer);
    set({
      detecting,
      detectRegion: { photoId: state.currentId, shape: region },
      noFaces: undefined,
    });
  },

  /** The detector found nothing: say so where it looked, then let it go. */
  noFacesFound(): void {
    const where = state.detectRegion ?? { photoId: state.currentId, shape: undefined };
    clearTimeout(noFacesTimer);
    set({ detecting: false, detectRegion: undefined, noFaces: where });
    noFacesTimer = setTimeout(() => set({ noFaces: undefined }), NO_FACES_MS);
  },
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

  reset(): void {
    const id = state.currentId;
    if (id) editAreas(id, (areas) => (areas.length === 0 ? areas : []));
  },

  setBlockPx(px: number): void {
    const id = state.currentId;
    if (id) updatePhoto(id, (p) => (p.blockPx === px ? p : { ...p, blockPx: px, rev: p.rev + 1 }));
  },

  setFacePadding(value: number): void {
    lastFacePadding = value;
    const id = state.currentId;
    set((s) => ({
      photos: s.photos.map((p) => {
        if (p.facePadding === value) return p;
        if (p.info.id === id) return { ...p, facePadding: value, rev: p.rev + 1 };
        // A photo with no areas yet has nothing to keep its old value for.
        if (p.areas.length === 0) return { ...p, facePadding: value };
        return p;
      }),
    }));
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

  async exportCurrent(confirmed = false): Promise<void> {
    const id = state.currentId;
    const photo = currentPhoto(state);
    if (!id || !photo || !hasMosaic(photo) || photo.status === 'exporting') return;
    if (!state.exportChosen) {
      set({ exportChoice: { anchor: 'export' } });
      return;
    }
    if (needsOverwriteConfirm(confirmed)) {
      set({ overwriteConfirm: { anchor: 'export' } });
      return;
    }
    if (await actions.exportPhoto(id)) await offerRemoval([id]);
  },

  /**
   * Saves the choice from the first-export popover, then runs the export it was opened for. The
   * popover already said that Replace original cannot be undone, so it does not ask again.
   */
  async chooseExportTarget(target: ExportTarget): Promise<void> {
    const choice = state.exportChoice;
    set({ exportChoice: undefined });
    await actions.setExportTarget(target);
    if (choice?.anchor === 'all') await actions.exportAll(true);
    else await actions.exportCurrent(true);
  },

  cancelExportChoice: (): void => set({ exportChoice: undefined }),

  /** Runs the export the Replace original confirmation was opened for. */
  async confirmOverwrite(dontAskAgain: boolean): Promise<void> {
    const confirm = state.overwriteConfirm;
    set({ overwriteConfirm: undefined, ...(dontAskAgain ? { overwriteAsk: false } : {}) });
    if (confirm?.anchor === 'all') await actions.exportAll(true);
    else if (confirm) await actions.exportCurrent(true);
  },

  cancelOverwrite: (): void => set({ overwriteConfirm: undefined }),

  async loadSettings(): Promise<void> {
    const { exportTarget, exportChosen, checkForUpdates } = await window.api.settings();
    set({ exportTarget, exportChosen, checkForUpdates });
  },

  async setCheckForUpdates(checkForUpdates: boolean): Promise<void> {
    set({ checkForUpdates });
    try {
      await window.api.setCheckForUpdates(checkForUpdates);
    } catch (cause) {
      notify(
        [`Could not save the setting, so it lasts until you close the app: ${errorText(cause)}`],
        'error',
      );
    }
  },

  async setExportTarget(exportTarget: ExportTarget): Promise<void> {
    set({ exportTarget, exportChosen: true });
    try {
      await window.api.setExportTarget(exportTarget);
    } catch (cause) {
      notify(
        [`Could not save the setting, so it lasts until you close the app: ${errorText(cause)}`],
        'error',
      );
    }
  },

  /** The quiet check when the app starts. A failure is only a console warning. */
  async checkForUpdatesOnStart(): Promise<void> {
    if (startupCheckDone) return;
    startupCheckDone = true;
    try {
      const result = await window.api.checkForUpdatesOnStart();
      if (result?.status === 'available') {
        set({
          update: { phase: 'available', version: result.version },
          updateNotes: result.notes,
          updatePromptHidden: false,
        });
      } else if (result?.status === 'error') {
        console.warn(`Could not check for updates: ${result.message}`);
      }
    } catch (cause) {
      console.warn(`Could not check for updates: ${errorText(cause)}`);
    }
  },

  /** The About dialog's button. */
  async checkForUpdates(): Promise<void> {
    if (state.aboutCheck.phase === 'checking') return;
    set({ aboutCheck: { phase: 'checking' } });
    try {
      const result = await window.api.checkForUpdates();
      if (result.status === 'available') {
        set({
          aboutCheck: { phase: 'idle' },
          update: { phase: 'available', version: result.version },
          updateNotes: result.notes,
        });
      } else if (result.status === 'up-to-date') {
        set({ aboutCheck: { phase: 'up-to-date' } });
      } else {
        set({ aboutCheck: { phase: 'error', message: result.message } });
      }
    } catch (cause) {
      set({ aboutCheck: { phase: 'error', message: errorText(cause) } });
    }
  },

  /** Download the update that was found, with progress. */
  async startUpdate(): Promise<void> {
    const current = state.update;
    if (current.phase !== 'available' && current.phase !== 'failed') return;
    const version = current.version;
    set({
      update: { phase: 'downloading', version, percent: undefined },
      updatePromptHidden: false,
    });
    const stop = window.api.onUpdateProgress((percent) =>
      set((s) => (s.update.phase === 'downloading' ? { update: { ...s.update, percent } } : {})),
    );
    try {
      const result = await window.api.downloadUpdate();
      if (!result.ok) {
        set({ update: { phase: 'failed', version, message: result.message } });
      } else if (result.next === 'restart') {
        set({ update: { phase: 'ready', version }, updatePromptHidden: false });
      } else {
        set({ update: { phase: 'opened', version, fileName: result.fileName } });
      }
    } catch (cause) {
      set({ update: { phase: 'failed', version, message: errorText(cause) } });
    } finally {
      stop();
    }
  },

  async installUpdate(): Promise<void> {
    if (state.update.phase !== 'ready') return;
    try {
      await window.api.installUpdate();
    } catch (cause) {
      notify([`Could not restart to update: ${errorText(cause)}`], 'error');
    }
  },

  hideUpdatePrompt: (): void => set({ updatePromptHidden: true }),

  setNotesOpen: (notesOpen: boolean): void =>
    set(notesOpen ? { notesOpen, aboutOpen: false } : { notesOpen }),

  /** Every photo with a mosaic, one after the other, in the background. */
  async exportAll(confirmed = false): Promise<void> {
    if (state.batch && !state.batch.finished) return;
    const ids = state.photos.filter(hasMosaic).map((p) => p.info.id);
    if (ids.length === 0) return;
    if (!state.exportChosen) {
      set({ exportChoice: { anchor: 'all' } });
      return;
    }
    if (needsOverwriteConfirm(confirmed)) {
      set({ overwriteConfirm: { anchor: 'all' } });
      return;
    }
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
