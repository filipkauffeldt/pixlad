import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFaces } from '../src/main/faces/detect';
import { decodeCoefficients } from '../src/main/jpeg/decode';
import { decodePlanes, planesToRgba } from '../src/main/jpeg/pixels';

const root = resolve(import.meta.dirname, '..');
const model = join(root, 'resources/models/face_detection_yunet_2026may.onnx');
const photo = join(root, 'fixtures/apollo11_crew.jpg');

describe.skipIf(!existsSync(model) || !existsSync(photo))('YuNet face detection', () => {
  it('finds the three faces of a public-domain crew photo', async () => {
    const decoded = decodeCoefficients(await readFile(photo));
    const rgba = planesToRgba(decoded, decodePlanes(decoded));
    const { width, height } = decoded.header.frame;
    const faces = await detectFaces(rgba, width, height, undefined, { modelPath: model });
    expect(faces.length).toBeGreaterThanOrEqual(3);
  });
});
