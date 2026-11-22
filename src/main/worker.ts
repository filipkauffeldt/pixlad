// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { renderMosaic } from '../shared/mosaic';
import type {
  DetectOptions,
  FaceDetection,
  MosaicOp,
  Point,
  Rect,
  TraceFace,
} from '../shared/types';
import { exportEdit, ExportFailure, type ExportRequest } from './export-photo';
import { detectFaces } from './faces/detect';
import { warmOutlineModels, withOutlineModels } from './faces/models';
import { traceOutlines } from './faces/outlines';
import { findPeople, type Person } from './faces/people';
import { decodeCoefficients } from './jpeg/decode';
import { iccProfile } from './jpeg/parse';
import { dcThumbnail, decodePlanes, planesToRgba } from './jpeg/pixels';
import { encodePng } from './png';

export type WorkerRequest =
  | { id: number; type: 'open'; path: string }
  | { id: number; type: 'preview'; op: MosaicOp }
  | { id: number; type: 'detect'; region: Rect; options?: DetectOptions | undefined }
  | { id: number; type: 'trace'; faces: TraceFace[] }
  | { id: number; type: 'warm' }
  | { id: number; type: 'thumb'; path: string }
  | { id: number; type: 'export'; request: ExportRequest };

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; failure: boolean };

const modelPath = (workerData as { modelPath: string }).modelPath;

const DETECTION_MARGIN = 0.08;

function withMargin(region: Rect, width: number, height: number): Rect {
  const margin = DETECTION_MARGIN * Math.max(width, height);
  const x0 = Math.max(0, region.x - margin / width);
  const y0 = Math.max(0, region.y - margin / height);
  const x1 = Math.min(1, region.x + region.w + margin / width);
  const y1 = Math.min(1, region.y + region.h + margin / height);
  return { type: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function centredIn(faces: FaceDetection[], region: Rect): FaceDetection[] {
  return faces.filter((f) => {
    const cx = f.box.x + f.box.w / 2;
    const cy = f.box.y + f.box.h / 2;
    return (
      cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h
    );
  });
}

function toDetections(people: Person[], photo: { width: number; height: number }): FaceDetection[] {
  const { width: W, height: H } = photo;
  const norm = (r: { x: number; y: number; w: number; h: number }): Rect => ({
    type: 'rect',
    x: r.x / W,
    y: r.y / H,
    w: r.w / W,
    h: r.h / H,
  });
  return people.flatMap((p) => {
    const x = Math.max(0, p.box.x);
    const y = Math.max(0, p.box.y);
    const right = Math.min(W, p.box.x + p.box.w);
    const bottom = Math.min(H, p.box.y + p.box.h);
    if (right <= x || bottom <= y) return [];
    const [eye, otherEye] = p.landmarks;
    return [
      {
        box: norm({ x, y, w: right - x, h: bottom - y }),
        score: p.score,
        angle: eye && otherEye ? Math.atan2(otherEye.y - eye.y, otherEye.x - eye.x) : 0,
        aspect: W / H,
        kind: p.kind,
        ...(p.confirmed ? { confirmed: true } : {}),
        ...(p.eyes ? { eyes: p.eyes.map(norm) } : {}),
      },
    ];
  });
}

// Per face: the outline, null to drop the face (a balaclava, a tattoo), undefined to keep its oval.
async function traceFaces(
  photo: { rgba: Uint8Array; width: number; height: number },
  faces: TraceFace[],
): Promise<(Point[] | null | undefined)[]> {
  const { width: W, height: H } = photo;
  const px = (r: Rect) => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
  const items = faces.map((f) => ({
    box: px(f.box),
    kind: f.kind ?? 'face',
    angle: f.angle ?? 0,
    confirmed: f.confirmed ?? f.kind !== 'head',
    ...(f.eyes ? { eyes: f.eyes.map(px) } : {}),
  }));
  const outlines = await withOutlineModels(() => traceOutlines(photo, items, dirname(modelPath)));
  return outlines.map((o) => (o ? o.map((p) => ({ x: p.x / W, y: p.y / H })) : o));
}

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
      const png = encodePng(patch.rgba, patch.width, patch.height, current.icc);
      return { x: patch.x, y: patch.y, width: patch.width, height: patch.height, png };
    }
    case 'detect': {
      if (!current) throw new Error('no photo is open');
      const photo = current;
      const wider = withMargin(request.region, photo.width, photo.height);
      const found: FaceDetection[] = request.options?.people
        ? await withOutlineModels(async () =>
            toDetections(await findPeople(photo, wider, dirname(modelPath)), photo),
          )
        : await detectFaces(photo.rgba, photo.width, photo.height, wider, { modelPath });
      return centredIn(found, request.region);
    }
    case 'warm':
      return warmOutlineModels(dirname(modelPath));
    case 'trace': {
      if (!current) throw new Error('no photo is open');
      return traceFaces(current, request.faces);
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
