// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// One worker script, three instances (current photo, thumbnails, exporter), so decoding and
// encoding never block the window.
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { renderMosaic } from '../shared/mosaic';
import type {
  DetectOptions,
  FaceDetection,
  FaceStyle,
  MosaicOp,
  Rect,
  TraceFace,
} from '../shared/types';
import { exportEdit, ExportFailure, type ExportRequest } from './export-photo';
import { detectFaces } from './faces/detect';
import { detectExperimental, traceExperimental } from './faces/experimental';
import { decodeCoefficients } from './jpeg/decode';
import { iccProfile } from './jpeg/parse';
import { dcThumbnail, decodePlanes, planesToRgba } from './jpeg/pixels';
import { encodePng } from './png';

export type WorkerRequest =
  | { id: number; type: 'open'; path: string }
  | { id: number; type: 'preview'; op: MosaicOp }
  | { id: number; type: 'detect'; region: Rect; options?: DetectOptions | undefined }
  | { id: number; type: 'trace'; faces: TraceFace[]; style: FaceStyle }
  | { id: number; type: 'thumb'; path: string }
  | { id: number; type: 'export'; request: ExportRequest };

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; failure: boolean };

const modelPath = (workerData as { modelPath: string }).modelPath;

/** The only decoded photo: upright RGBA plus the profile its preview patches carry. */
let current:
  { width: number; height: number; rgba: Uint8Array; icc: Buffer | undefined } | undefined;

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      current = undefined;
      const decoded = decodeCoefficients(await readFile(request.path));
      const rgba = planesToRgba(decoded, decodePlanes(decoded));
      const swap = decoded.header.orientation >= 5;
      current = {
        width: swap ? decoded.header.frame.height : decoded.header.frame.width,
        height: swap ? decoded.header.frame.width : decoded.header.frame.height,
        rgba,
        icc: iccProfile(decoded.header.segments),
      };
      return { width: current.width, height: current.height };
    }
    case 'preview': {
      if (!current) throw new Error('no photo is open');
      const patch = renderMosaic(current.rgba, current.width, current.height, request.op);
      if (!patch) return null;
      const rgba = patch.rgba; // alpha is 255 on covered pixels and 0 elsewhere
      const png = encodePng(rgba, patch.width, patch.height, current.icc);
      return { x: patch.x, y: patch.y, width: patch.width, height: patch.height, png };
    }
    case 'detect': {
      if (!current) throw new Error('no photo is open');
      // A face the selection cuts through is found whole: detect over the selection plus a
      // margin, then keep the faces whose centre lies inside the selection.
      const { width, height } = current;
      const margin = 0.08 * Math.max(width, height);
      const r = request.region;
      const x0 = Math.max(0, r.x - margin / width);
      const y0 = Math.max(0, r.y - margin / height);
      const x1 = Math.min(1, r.x + r.w + margin / width);
      const y1 = Math.min(1, r.y + r.h + margin / height);
      const wider: Rect = { type: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const found: FaceDetection[] = request.options
        ? await detectExperimental(current, wider, request.options, modelPath)
        : await detectFaces(current.rgba, width, height, wider, { modelPath });
      return found.filter((f) => {
        const cx = f.box.x + f.box.w / 2;
        const cy = f.box.y + f.box.h / 2;
        return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
      });
    }

    case 'trace': {
      if (!current) throw new Error('no photo is open');
      return traceExperimental(current, request.faces, request.style, modelPath);
    }
    case 'thumb': {
      const decoded = decodeCoefficients(await readFile(request.path), { dcOnly: true });
      const thumb = dcThumbnail(decoded);
      return encodePng(thumb.rgba, thumb.width, thumb.height, iccProfile(decoded.header.segments));
    }
    case 'export':
      return exportEdit(request.request);
  }
}

parentPort!.on('message', (request: WorkerRequest) => {
  handle(request).then(
    (value) => parentPort!.postMessage({ id: request.id, ok: true, value } satisfies WorkerReply),
    (cause: unknown) =>
      parentPort!.postMessage({
        id: request.id,
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
        failure: cause instanceof ExportFailure,
      } satisfies WorkerReply),
  );
});
