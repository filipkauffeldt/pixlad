// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { UpdateCheck, UpdateDownload } from './update';
import type { DetectOptions, FaceDetection, MosaicOp, Point, Rect, TraceFace } from './types';

/** Metadata only; the pixels stay in the main process. */
export interface PhotoInfo {
  id: string;
  path: string;
  name: string;
  /** Size after EXIF orientation, in pixels. */
  width: number;
  height: number;
}

export interface Refusal {
  name: string;
  /** Why, as a sentence fragment after the quoted name. */
  reason: string;
}

export interface AddResult {
  photos: PhotoInfo[];
  refused: Refusal[];
  duplicates: number;
}

export interface PreviewPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  png: Uint8Array;
}

export type ExportOutcome =
  | { ok: true; path: string; name: string; replaced: boolean; overwrote: boolean }
  | { ok: false; message: string };

/** `suffix` writes `<name>_edit.jpg` next to the source; `overwrite` replaces the source. */
export type ExportTarget = 'suffix' | 'overwrite';

export const isExportTarget = (value: unknown): value is ExportTarget =>
  value === 'suffix' || value === 'overwrite';

export type Theme = 'system' | 'light' | 'dark';

export const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark';

export type AfterExport = 'ask' | 'keep' | 'remove';

export const isAfterExport = (value: unknown): value is AfterExport =>
  value === 'ask' || value === 'keep' || value === 'remove';

export interface Settings {
  exportTarget: ExportTarget;
  /** Once true, the first-export choice stops showing. */
  exportChosen: boolean;
  checkForUpdates: boolean;
  theme: Theme;
  /** Missing in old settings files, which count as `ask`. */
  afterExport: AfterExport;
  window?: WindowState;
}

/** Bounds are those of the window when not maximized. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  exportTarget: 'suffix',
  exportChosen: false,
  checkForUpdates: true,
  theme: 'system',
  afterExport: 'ask',
};

export interface ExportNames {
  source: string;
  /** E.g. `_DSC1234_edit.JPG`, or `_DSC1234_edit-2.JPG` when that exists. */
  copy: string;
}

export const SOURCE_URL = 'https://github.com/filipkauffeldt/pixlad';

export interface Notice {
  title: string;
  homepage?: string;
  text: string;
}

export interface AboutInfo {
  version: string;
  license: string;
  notices: Notice[];
  hasChromiumLicenses: boolean;
  /** False for a source run and for prerelease builds. */
  canCheckForUpdates: boolean;
}

export interface Api {
  pathsForFiles(files: File[]): string[];
  openDialog(): Promise<string[]>;
  addPaths(paths: string[]): Promise<AddResult>;
  removePhoto(id: string): Promise<void>;
  openPhoto(id: string): Promise<void>;
  preview(id: string, op: MosaicOp): Promise<PreviewPatch | null>;
  detect(id: string, region: Rect, options?: DetectOptions): Promise<FaceDetection[]>;
  /** Per face: an outline, null to drop the face, undefined to keep it. */
  trace(id: string, faces: TraceFace[]): Promise<(Point[] | null | undefined)[]>;
  warmFaces(): Promise<void>;
  exportPhoto(id: string, op: MosaicOp): Promise<ExportOutcome>;
  settings(): Promise<Settings>;
  /** Also sets `exportChosen`. */
  setExportTarget(target: ExportTarget): Promise<void>;
  /** Reveals the file the photo was last exported to. */
  showInFolder(id: string): Promise<void>;
  exportNames(id: string): Promise<ExportNames>;
  setCheckForUpdates(enabled: boolean): Promise<void>;
  setTheme(theme: Theme): Promise<void>;
  setAfterExport(choice: AfterExport): Promise<void>;
  about(): Promise<AboutInfo>;
  openChromiumLicenses(): Promise<void>;
  /** Undefined when the setting is off or this build does not check. */
  checkForUpdatesOnStart(): Promise<UpdateCheck | undefined>;
  checkForUpdates(): Promise<UpdateCheck>;
  /** Progress arrives through `onUpdateProgress`. */
  downloadUpdate(): Promise<UpdateDownload>;
  /** Asks first if some mosaics are not exported. */
  installUpdate(): Promise<void>;
  openReleaseNotes(version: string): Promise<void>;
  /** Percent, or undefined when the size is not known. Returns an unsubscribe. */
  onUpdateProgress(listener: (percent: number | undefined) => void): () => void;
  openSource(): Promise<void>;
  setUnexported(count: number): void;
}

declare global {
  interface Window {
    api: Api;
  }
}
