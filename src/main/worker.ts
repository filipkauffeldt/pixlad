// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
// One worker script, three instances (current photo, thumbnails, exporter), so decoding and
// encoding never block the window.
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { renderMosaic } from '../shared/mosaic';
import type { FaceDetection, MosaicOp, Rect } from '../shared/types';
import { exportEdit, ExportFailure, type ExportRequest } from './export-photo';
import { detectFaces } from './faces/detect';
import { decodeCoefficients } from './jpeg/decode';
import { iccProfile } from './jpeg/parse';
import { dcThumbnail, decodePlanes, planesToRgba } from './jpeg/pixels';
import { encodePng } from './png';

export type WorkerRequest =
  | { id: number; type: 'open'; path: string }
  | { id: number; type: 'preview'; op: MosaicOp }
  | { id: number; type: 'detect'; region: Rect }
  | { id: number; type: 'thumb'; path: string }
  | { id: number; type: 'export'; request: ExportRequest };

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; failure: boolean };

const modelPath = (workerData as { modelPath: string }).modelPath;

/**
 * The region grown by 8% of the long edge on every side, inside the photo, so a face the
 * selection cuts through is detected whole.
 */
function withMargin(region: Rect, width: number, height: number): Rect {
  const margin = 0.08 * Math.max(width, height);
  const x0 = Math.max(0, region.x - margin / width);
  const y0 = Math.max(0, region.y - margin / height);
  const x1 = Math.min(1, region.x + region.w + margin / width);
  const y1 = Math.min(1, region.y + region.h + margin / height);
  return { type: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

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
      const found: FaceDetection[] = await detectFaces(
        current.rgba,
        current.width,
        current.height,
        withMargin(request.region, current.width, current.height),
        { modelPath },
      );
      return found;
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
