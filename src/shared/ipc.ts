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
  { ok: true; path: string; name: string; replaced: boolean } | { ok: false; message: string };

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
  /** Tell the main process how many photos have mosaics that are not exported (for closing). */
  setUnexported(count: number): void;
}

declare global {
  interface Window {
    api: Api;
  }
}
