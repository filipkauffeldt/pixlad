// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import type { UpdateCheck, UpdateDownload } from './update';
import type { FaceDetection, MosaicOp, Rect } from './types';

/** What the renderer knows about a photo in the session. Never the pixels. */
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
  /** How many of the given files were already in the session and skipped. */
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

/** Where an export goes: `<name>_edit.jpg` next to the source, or over the source itself. */
export type ExportTarget = 'suffix' | 'overwrite';

export const isExportTarget = (value: unknown): value is ExportTarget =>
  value === 'suffix' || value === 'overwrite';

/** What the app keeps between runs. */
export interface Settings {
  exportTarget: ExportTarget;
  /** Whether the app looks for a newer release when it starts. */
  checkForUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = { exportTarget: 'suffix', checkForUpdates: true };

/** Where the source code is published, as the GPL asks for. */
export const SOURCE_URL = 'https://github.com/filipkauffeldt/pixlad';

/** One part of THIRD_PARTY_NOTICES.txt: e.g. `react 19.3.1 (MIT)` and its licence text. */
export interface Notice {
  title: string;
  homepage?: string;
  text: string;
}

export interface AboutInfo {
  version: string;
  /** The GPL text from LICENSE. */
  license: string;
  notices: Notice[];
  /** Whether Electron's file with Chromium's licences was found, so it can be opened. */
  hasChromiumLicenses: boolean;
  /** Whether this build looks for updates. A source run and the prerelease builds do not. */
  canCheckForUpdates: boolean;
}

/** The surface the preload exposes as `window.api`. */
export interface Api {
  /** Real file-system paths of dropped files and folders. */
  pathsForFiles(files: File[]): string[];
  openDialog(): Promise<string[]>;
  addPaths(paths: string[]): Promise<AddResult>;
  removePhoto(id: string): Promise<void>;
  openPhoto(id: string): Promise<void>;
  preview(id: string, op: MosaicOp): Promise<PreviewPatch | null>;
  detect(id: string, region: Rect): Promise<FaceDetection[]>;
  exportPhoto(id: string, op: MosaicOp): Promise<ExportOutcome>;
  /** Ask whether to take exported photos out of the session. `name` is given for a single photo. */
  confirmRemoveExported(count: number, name: string | undefined): Promise<boolean>;
  settings(): Promise<Settings>;
  setExportTarget(target: ExportTarget): Promise<void>;
  setCheckForUpdates(enabled: boolean): Promise<void>;
  about(): Promise<AboutInfo>;
  openChromiumLicenses(): Promise<void>;
  /** The check at start: undefined when the setting is off or this build does not check. */
  checkForUpdatesOnStart(): Promise<UpdateCheck | undefined>;
  checkForUpdates(): Promise<UpdateCheck>;
  /** Downloads what the last check found. Progress arrives through `onUpdateProgress`. */
  downloadUpdate(): Promise<UpdateDownload>;
  /** Quits and installs the downloaded update, after asking if mosaics are not exported. */
  installUpdate(): Promise<void>;
  /** Percent of the download, or undefined when the size is not known. Returns an unsubscribe. */
  onUpdateProgress(listener: (percent: number | undefined) => void): () => void;
  /** Open the source code repository in the browser. */
  openSource(): Promise<void>;
  /** Tell the main process how many photos have mosaics that are not exported (for closing). */
  setUnexported(count: number): void;
}

declare global {
  interface Window {
    api: Api;
  }
}
