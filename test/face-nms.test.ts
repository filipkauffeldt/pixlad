import { describe, expect, it } from 'vitest';
import {
  intersectionOverUnion,
  mergeOverlappingDetections,
  nonMaximumSuppression,
} from '../src/main/faces/nms';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const detection = (b: ReturnType<typeof box>, score: number) => ({ box: b, score, landmarks: [] });

describe('non-maximum suppression', () => {
  // A 10x10 box shifted by 4 px overlaps it by IoU 6/14 (about 0.43).
  const strong = { box: box(0, 0, 10, 10), score: 0.9 };

  it('drops the weaker of two boxes that overlap by more than the threshold', () => {
    const weak = { box: box(4, 0, 10, 10), score: 0.8 };
    expect(nonMaximumSuppression([weak, strong], 0.4)).toEqual([strong]);
  });

  it('keeps both boxes when they overlap by exactly the threshold', () => {
    // IoU of 30 / 100 = 0.3 exactly: two 13x10 boxes, 6 px of overlap.
    const a = { box: box(0, 0, 13, 10), score: 0.9 };
    const b = { box: box(7, 0, 13, 10), score: 0.8 };
    expect(intersectionOverUnion(a.box, b.box)).toBe(0.3);
    expect(nonMaximumSuppression([a, b], 0.3)).toEqual([a, b]);
    expect(nonMaximumSuppression([a, b], 0.29)).toEqual([a]);
  });

  it('keeps boxes that merely touch', () => {
    const next = { box: box(10, 0, 10, 10), score: 0.8 };
    expect(nonMaximumSuppression([strong, next], 0)).toEqual([strong, next]);
  });

  it('keeps the highest score first whatever the input order', () => {
    const weak = { box: box(100, 0, 10, 10), score: 0.5 };
    expect(nonMaximumSuppression([weak, strong], 0.5)).toEqual([strong, weak]);
  });

  it('stops once it has kept topK boxes', () => {
    const boxes = [0, 100, 200].map((x, i) => ({ box: box(x, 0, 10, 10), score: 0.9 - i / 10 }));
    expect(nonMaximumSuppression(boxes, 0.5, 2)).toEqual(boxes.slice(0, 2));
    expect(nonMaximumSuppression(boxes, 0.5, 3)).toEqual(boxes);
  });

  it('keeps up to 5000 boxes by default', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({
      box: box(i * 20, 0, 10, 10),
      score: 1 - i / 10_000,
    }));
    expect(nonMaximumSuppression(many, 0.5)).toHaveLength(5000);
  });
});

describe('merging overlapping detections', () => {
  const a = detection(box(0, 0, 13, 10), 0.7);

  it('merges two boxes that overlap by exactly the IoU threshold', () => {
    // IoU 60 / 200 = 0.3 exactly, and only 46% of either box is shared.
    const b = detection(box(7, 0, 13, 10), 0.9);
    expect(mergeOverlappingDetections([a, b], 0.3)).toHaveLength(1);
    expect(mergeOverlappingDetections([a, b], 0.31)).toHaveLength(2);
  });

  it('merges a small box that is half inside a large one even at a tiny IoU', () => {
    const large = detection(box(0, 0, 100, 100), 0.9);
    const small = detection(box(95, 0, 10, 10), 0.8); // 50 of its 100 px inside: IoU 0.005
    expect(mergeOverlappingDetections([large, small], 0.3)).toHaveLength(1);
  });

  it('keeps a small box apart when less than half of it is inside a large one', () => {
    const large = detection(box(0, 0, 100, 100), 0.9);
    const small = detection(box(96, 0, 10, 10), 0.8); // 40 of its 100 px inside
    expect(mergeOverlappingDetections([large, small], 0.3)).toHaveLength(2);
  });

  it('keeps boxes that only touch', () => {
    const next = detection(box(13, 0, 13, 10), 0.8);
    expect(mergeOverlappingDetections([a, next], 0)).toHaveLength(2);
  });

  it('replaces a cluster with the union of its boxes', () => {
    const fragment = detection(box(0, 0, 10, 20), 0.95);
    const whole = detection(box(5, 0, 20, 20), 0.8);
    const [merged] = mergeOverlappingDetections([fragment, whole], 0.3);
    expect(merged!.box).toEqual(box(0, 0, 25, 20));
  });

  it('takes the score and landmarks of the best box in the cluster', () => {
    const weak = { box: box(0, 0, 10, 10), score: 0.6, landmarks: [{ x: 1, y: 1 }] };
    const best = { box: box(2, 0, 10, 10), score: 0.9, landmarks: [{ x: 7, y: 7 }] };
    const [merged] = mergeOverlappingDetections([weak, best], 0.3);
    expect(merged).toMatchObject({ score: 0.9, landmarks: [{ x: 7, y: 7 }] });
  });

  it('chains boxes that only overlap through a middle one', () => {
    const left = detection(box(0, 0, 10, 10), 0.6);
    const middle = detection(box(5, 0, 10, 10), 0.7);
    const right = detection(box(10, 0, 10, 10), 0.8);
    expect(intersectionOverUnion(left.box, right.box)).toBe(0);
    expect(mergeOverlappingDetections([left, middle, right], 0.3)).toHaveLength(1);
  });

  it('lists the clusters strongest first', () => {
    const far = detection(box(500, 0, 10, 10), 0.95);
    const merged = mergeOverlappingDetections([a, far], 0.3);
    expect(merged.map((m) => m.score)).toEqual([0.95, 0.7]);
  });
});
