// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Filip Kauffeldt
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clamp, polygonBounds, shapeBounds, simplifyPolygon } from '../shared/geometry';
import type { Point, Rect, Shape } from '../shared/types';
import {
  areaIndexAt,
  areaShape,
  clampToPicture,
  FIT_MARGIN,
  isNearPicture,
  isOnPicture,
  flipsHeld,
  withFlips,
} from './retouch';
import { isMac } from './flips';
import { actions, hasMosaic, opOf, useApp, type PhotoState } from './store';
import {
  FIT_VIEW,
  ZOOM_STEP,
  levelScale,
  overPicture,
  panBy,
  reclamp,
  viewLayout,
  wheelPanDelta,
  wheelZoomFactor,
  zoomBy,
  zoomTo,
  zoomPercent,
  type ZoomContext,
  type ZoomView,
} from './view-transform';

const CLICK_PX = 4;
const MIN_AREA_PX = 6;

/** Each outline's halo has its own class: it must never match what counts the outlines. */
const haloFor = {
  areaOn: 'haloOn',
  areaOff: 'haloOff',
  areaSubtract: 'haloSubtract',
} as const;

interface Patch {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Drag {
  start: Point;
  onPicture: boolean;
  entered: boolean;
  lasso: boolean;
  mode: 'add' | 'subtract';
  moved: boolean;
}

const rectFrom = (a: Point, b: Point): Rect => ({
  type: 'rect',
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});

/** The photo, its mosaic preview and the drawing overlay, with zoom and pan. */
export function Stage({
  photo,
  onZoom,
}: {
  photo: PhotoState;
  onZoom: (percent: number | undefined) => void;
}) {
  const app = useApp();
  const id = photo.info.id;
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const [panHeld, setPanHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [peek, setPeek] = useState(false);
  // The pointer over the stage (CSS px) and whether a drawing drag is under way, for the hover.
  const [hoverAt, setHoverAt] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [draftRect, setDraftRect] = useState<Rect | undefined>();
  const [draftPoints, setDraftPoints] = useState<Point[]>([]);
  const dpr = window.devicePixelRatio || 1;

  const iw = photo.info.width;
  const ih = photo.info.height;
  const image = { width: iw, height: ih };

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = (): void => setSize({ w: element.clientWidth, h: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = Math.max(
    0.01,
    Math.min(1 / dpr, (size.w - 2 * FIT_MARGIN) / iw, (size.h - 2 * FIT_MARGIN) / ih),
  );
  const base = { scale: fit, offset: { x: (size.w - iw * fit) / 2, y: (size.h - ih * fit) / 2 } };
  const context: ZoomContext = { base, image, viewport: { width: size.w, height: size.h }, dpr };
  const shown = reclamp(view, context);
  const layout = viewLayout(shown, base, image, dpr);
  const pw = iw * layout.scale;
  const ph = ih * layout.scale;

  // A dialog or popover is open: the photo behind it takes no hover, right-click or Delete. The
  // pointer can rest on an area while one opens, and no pointerleave follows until it moves.
  const dialogOpen =
    app.aboutOpen ||
    app.notesOpen ||
    app.removeQuestion !== undefined ||
    app.overwriteConfirm !== undefined ||
    app.exportChoice !== undefined ||
    app.shortcutsOpen ||
    app.removePhotoQuestion !== undefined;

  // The topmost area under the pointer: what a click would switch. None while drawing, panning,
  // peeking at the bare photo, or with a dialog open.
  let hovered = -1;
  // Where a drag cannot start, the cursor stays an arrow instead of the drawing crosshair.
  let outside = false;
  if (hoverAt && !dragging && !panHeld && !panning && !peek && !dialogOpen) {
    const unit = { x: (hoverAt.x - layout.offset.x) / pw, y: (hoverAt.y - layout.offset.y) / ph };
    if (isOnPicture(unit)) hovered = areaIndexAt(photo.areas, unit, photo.facePadding);
    outside = !isNearPicture(unit, pw, ph);
  }

  const latest = useRef({ context, shown, layout, pw, ph, hovered });
  useLayoutEffect(() => {
    latest.current = { context, shown, layout, pw, ph, hovered };
  });
  const pointer = useRef<Point | null>(null);

  useEffect(() => {
    onZoom(shown.scale === null ? undefined : zoomPercent(layout.scale, dpr));
  }, [shown.scale, layout.scale, dpr, onZoom]);

  // ---- mosaic preview: the patch is a PNG with the photo's own profile, so it is colour-managed
  // exactly like the JPEG under it.
  const op = useMemo(() => opOf(photo), [photo]);
  const opKey = JSON.stringify(op);
  const covered = hasMosaic(photo);
  useEffect(() => {
    window.api.openPhoto(id).catch(() => undefined);
  }, [id]);
  const patchUrl = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!covered) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      window.api
        .preview(id, op)
        .then((result) => {
          if (cancelled) return;
          if (patchUrl.current) URL.revokeObjectURL(patchUrl.current);
          if (!result) {
            patchUrl.current = undefined;
            setPatch(null);
            return;
          }
          const blob = new Blob([result.png as BlobPart], { type: 'image/png' });
          patchUrl.current = URL.createObjectURL(blob);
          setPatch({
            url: patchUrl.current,
            x: result.x,
            y: result.y,
            width: result.width,
            height: result.height,
          });
        })
        .catch(() => undefined); // superseded by another photo or request
    }, 40);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, opKey, covered]);
  useEffect(
    () => () => {
      if (patchUrl.current) URL.revokeObjectURL(patchUrl.current);
    },
    [],
  );

  // ---- keyboard: Z, Ctrl +/-, Ctrl+0, Space. Matched by what the key prints, never by position.
  useEffect(() => {
    const editing = (target: EventTarget | null): boolean =>
      target instanceof HTMLInputElement && target.type !== 'range';
    // Fit when zoomed, 100% when fit: around the pointer over the picture, else the centre.
    const toggleZoom = (): void => {
      const { context: ctx, shown: now } = latest.current;
      if (now.scale !== null) {
        setView(FIT_VIEW);
        return;
      }
      const at = pointer.current;
      const centre = { x: ctx.viewport.width / 2, y: ctx.viewport.height / 2 };
      const anchor = at && overPicture(latest.current.layout, image, at) ? at : centre;
      setView(zoomTo(now, ctx, anchor, levelScale(1, dpr)));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.getModifierState('AltGraph')) return;
      const primary = isMac ? event.metaKey : event.ctrlKey;
      const other = isMac ? event.ctrlKey : event.metaKey;
      if (other) return;
      const { context: ctx, shown: now } = latest.current;
      const centre = { x: ctx.viewport.width / 2, y: ctx.viewport.height / 2 };
      if (!primary && (event.key === 'z' || event.key === 'Z') && !editing(event.target)) {
        event.preventDefault();
        toggleZoom();
      } else if (primary && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        setView(zoomBy(now, ctx, centre, ZOOM_STEP));
      } else if (primary && event.key === '-') {
        event.preventDefault();
        setView(zoomBy(now, ctx, centre, 1 / ZOOM_STEP));
      } else if (primary && event.key === '0') {
        event.preventDefault();
        setView(FIT_VIEW);
      } else if (!primary && event.key === ' ' && !editing(event.target)) {
        if (!(event.target instanceof HTMLButtonElement)) event.preventDefault();
        setPanHeld(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === ' ') setPanHeld(false);
    };
    const onBlur = (): void => setPanHeld(false);
    // Delete or Backspace over an area removes that area. This runs in the capture phase, ahead
    // of the window handler in App that takes a photo out of the session on Delete, and stops
    // the key there, so that one only ever sees a Delete with the pointer off every area.
    const onDeleteKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (event.altKey || event.ctrlKey || event.metaKey || editing(event.target)) return;
      const over = latest.current.hovered;
      if (over < 0) return;
      event.preventDefault();
      event.stopPropagation();
      actions.removeArea(over);
    };
    window.addEventListener('keydown', onDeleteKey, true);
    // The zoom button in the footer does what the Z key does.
    document.addEventListener('pixlad:toggle-zoom', toggleZoom);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDeleteKey, true);
      document.removeEventListener('pixlad:toggle-zoom', toggleZoom);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dpr, iw, ih]);

  // Hold B to see the photo as it was: the mosaic patch and every outline hide until the key goes
  // up or the window loses focus. Not while typing in a field.
  useEffect(() => {
    const isB = (event: KeyboardEvent): boolean => event.key === 'b' || event.key === 'B';
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isB(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      const typing =
        (target instanceof HTMLInputElement && target.type !== 'range') ||
        target instanceof HTMLTextAreaElement;
      if (!typing) setPeek(true);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isB(event)) setPeek(false);
    };
    const onBlur = (): void => setPeek(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Ctrl/Cmd+wheel zooms (also a trackpad pinch), a plain wheel pans a zoomed view.
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      const { context: ctx, shown: now } = latest.current;
      if (!event.ctrlKey && !event.metaKey) {
        if (now.scale === null) return;
        event.preventDefault();
        setView(panBy(now, ctx, wheelPanDelta(event)));
        return;
      }
      event.preventDefault();
      const box = element.getBoundingClientRect();
      setView(
        zoomBy(
          now,
          ctx,
          { x: event.clientX - box.left, y: event.clientY - box.top },
          wheelZoomFactor(event),
        ),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // ---- drawing
  const drag = useRef<Drag | null>(null);
  const panDrag = useRef<{ last: Point } | null>(null);

  const toUnit = (event: { clientX: number; clientY: number }): Point => {
    const box = stageRef.current!.getBoundingClientRect();
    const { layout: l, pw: w, ph: h } = latest.current;
    return {
      x: (event.clientX - box.left - l.offset.x) / w,
      y: (event.clientY - box.top - l.offset.y) / h,
    };
  };

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const surface = stageRef.current!;
    if (panHeld) {
      event.preventDefault();
      surface.setPointerCapture(event.pointerId);
      panDrag.current = { last: { x: event.clientX, y: event.clientY } };
      setPanning(true);
      return;
    }
    const raw = toUnit(event);
    const { pw: w, ph: h } = latest.current;
    if (!isNearPicture(raw, w, h)) return;
    event.preventDefault();
    const { outline, mode } = withFlips(app, flipsHeld(event, isMac));
    const lasso = outline === 'lasso';
    const start = clampToPicture(raw);
    drag.current = {
      start,
      onPicture: isOnPicture(raw),
      entered: isOnPicture(raw),
      lasso,
      mode,
      moved: false,
    };
    surface.setPointerCapture(event.pointerId);
    setDragging(true);
    if (lasso) setDraftPoints([start]);
  };

  // Right-click removes the topmost area under the pointer.
  const onContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    if (panHeld || drag.current || peek || dialogOpen) return;
    const unit = toUnit(event);
    if (!isOnPicture(unit)) return;
    const index = areaIndexAt(photo.areas, unit, photo.facePadding);
    if (index >= 0) actions.removeArea(index);
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    const box = stageRef.current!.getBoundingClientRect();
    pointer.current = { x: event.clientX - box.left, y: event.clientY - box.top };
    setHoverAt(pointer.current);
    if (panDrag.current) {
      const delta = {
        x: event.clientX - panDrag.current.last.x,
        y: event.clientY - panDrag.current.last.y,
      };
      panDrag.current.last = { x: event.clientX, y: event.clientY };
      const { context: ctx, shown: now } = latest.current;
      setView(panBy(now, ctx, delta));
      return;
    }
    const d = drag.current;
    if (!d) return;
    const raw = toUnit(event);
    if (isOnPicture(raw)) d.entered = true;
    const point = clampToPicture(raw);
    d.moved = true;
    const { pw: w, ph: h } = latest.current;
    if (d.lasso) {
      setDraftPoints((current) => {
        const last = current[current.length - 1];
        if (last && Math.hypot((last.x - point.x) * w, (last.y - point.y) * h) < 2) return current;
        return [...current, point];
      });
    } else setDraftRect(rectFrom(d.start, point));
  };

  const onPointerUp = (event: React.PointerEvent): void => {
    const surface = stageRef.current!;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (panDrag.current) {
      panDrag.current = null;
      setPanning(false);
      return;
    }
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    const { pw: w, ph: h } = latest.current;
    const rawEnd = toUnit(event);
    const end = clampToPicture(rawEnd);
    const entered = d.entered || isOnPicture(rawEnd);
    const points = [...draftPoints, end];
    setDraftPoints([]);
    setDraftRect(undefined);

    const clicked =
      Math.hypot((end.x - d.start.x) * w, (end.y - d.start.y) * h) < CLICK_PX &&
      (!d.lasso || points.length < 3 || !d.moved);
    if (clicked) {
      // A click, not a drag, switches the topmost area under it on or off, whatever the tool.
      if (!d.onPicture) return;
      const index = areaIndexAt(photo.areas, end, photo.facePadding);
      if (index >= 0) actions.toggleArea(index);
      return;
    }
    if (d.lasso) {
      if (points.length < 3 || !entered) return;
      const simplified = simplifyPolygon(points, 1.5 / Math.max(w, h));
      if (simplified.length < 3) return;
      const polygon: Shape = { type: 'polygon', points: simplified };
      if (app.target === 'faces') {
        const bounds = polygonBounds(simplified);
        if (bounds.w * w < MIN_AREA_PX || bounds.h * h < MIN_AREA_PX) return;
        if (d.mode === 'subtract') actions.removeFacesInside(polygon);
        else void detect(bounds, simplified);
      } else actions.addShape(polygon, d.mode);
      return;
    }
    const rect = rectFrom(d.start, end);
    if (rect.w * w < MIN_AREA_PX || rect.h * h < MIN_AREA_PX) return;
    if (app.target === 'faces') {
      // Subtract removes the faces already found in the area; it never runs the detector.
      if (d.mode === 'subtract') actions.removeFacesInside(rect);
      else void detect(rect);
    } else actions.addShape(rect, d.mode);
  };

  const detect = (region: Rect, lasso?: readonly Point[]): Promise<void> =>
    actions.detectFaces(id, region, lasso);

  const toPx = (p: Point): string => `${layout.offset.x + p.x * pw},${layout.offset.y + p.y * ph}`;
  const shapePath = (shape: Shape): string =>
    shape.type === 'rect'
      ? `M${toPx({ x: shape.x, y: shape.y })}L${toPx({ x: shape.x + shape.w, y: shape.y })}L${toPx({ x: shape.x + shape.w, y: shape.y + shape.h })}L${toPx({ x: shape.x, y: shape.y + shape.h })}Z`
      : `M${shape.points.map(toPx).join('L')}Z`;

  const imageStyle = (x: number, y: number, w: number, h: number): React.CSSProperties => ({
    left: layout.offset.x + x * layout.scale,
    top: layout.offset.y + y * layout.scale,
    width: w * layout.scale,
    height: h * layout.scale,
    imageRendering: layout.scale * dpr >= 1 ? 'pixelated' : 'auto',
  });

  // The region being searched stays in view, with its label next to it; with no region (the whole
  // photo) the label sits over the photo's top left. "No faces found" stays there a moment.
  const looking = app.detectRegion?.photoId === id ? app.detectRegion : undefined;
  const found = app.noFaces?.photoId === id ? app.noFaces : undefined;
  const marked = looking ?? found;
  const markedBox = marked?.shape && shapeBounds(marked.shape);
  const labelAt = ((): { left: number; top: number } => {
    const height = 24;
    const left = (x: number): number => clamp(x, 8, Math.max(8, size.w - 160));
    if (!markedBox)
      return { left: left(layout.offset.x + 10), top: Math.max(8, layout.offset.y + 10) };
    const x = layout.offset.x + markedBox.x * pw;
    const top = layout.offset.y + markedBox.y * ph;
    const bottom = top + markedBox.h * ph;
    if (bottom + 6 + height <= size.h) return { left: left(x), top: bottom + 6 };
    return { left: left(x), top: Math.max(8, top - 6 - height) };
  })();

  return (
    <div
      ref={stageRef}
      className={`stage ${panHeld ? 'panning' : 'drawing'}${hovered >= 0 ? ' overArea' : ''}${outside ? ' outside' : ''}`}
      style={panning ? { cursor: 'grabbing' } : undefined}
      data-testid="stage"
      data-fit={shown.scale === null ? 'true' : 'false'}
      data-peek={peek ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onPointerLeave={() => {
        pointer.current = null;
        setHoverAt(null);
      }}
    >
      {size.w > 0 && (
        <>
          <img
            src={`pixlad://photo/${id}?v=${photo.fileVersion}`}
            alt={photo.info.name}
            draggable={false}
            style={imageStyle(0, 0, iw, ih)}
            data-testid="photo"
          />
          {covered && patch && (
            <img
              src={patch.url}
              alt=""
              className="patch"
              draggable={false}
              style={imageStyle(patch.x, patch.y, patch.width, patch.height)}
              data-testid="mosaic-patch"
            />
          )}
          <svg className="overlay" data-testid="overlay" role="img" aria-label="Retouch areas">
            {photo.areas.map((area, i) => {
              const d = shapePath(areaShape(area, photo.facePadding));
              const hover = i === hovered ? ' areaHover' : '';
              const state = !area.enabled
                ? 'areaOff'
                : area.mode === 'subtract'
                  ? 'areaSubtract'
                  : 'areaOn';
              return (
                <g key={i}>
                  <path
                    d={d}
                    className={`halo ${haloFor[state]}${i === hovered ? ' haloHover' : ''}`}
                  />
                  <path
                    d={d}
                    className={`${state}${hover}`}
                    data-testid="area"
                    data-kind={area.kind}
                    data-enabled={area.enabled}
                  />
                </g>
              );
            })}
            {draftRect && (
              <>
                <path d={shapePath(draftRect)} className="halo haloDraft" />
                <path d={shapePath(draftRect)} className="draft" />
              </>
            )}
            {draftPoints.length > 1 && (
              <>
                <path d={`M${draftPoints.map(toPx).join('L')}`} className="halo haloDraft" />
                <path d={`M${draftPoints.map(toPx).join('L')}`} className="draft" />
              </>
            )}
            {marked?.shape && (
              <>
                <path d={shapePath(marked.shape)} className="halo haloDraft" />
                <path d={shapePath(marked.shape)} className="draft" data-testid="detect-region" />
              </>
            )}
          </svg>
          {marked && (
            <div className="regionLabel" style={labelAt} data-testid="detect-label">
              {looking ? 'Looking for faces…' : 'No faces found'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
