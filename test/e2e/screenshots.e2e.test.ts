// Takes the README screenshots with generated photos. Skipped unless SCREENSHOT_DIR is set:
//   SCREENSHOT_DIR=/abs/folder xvfb-run -a pnpm vitest run --config vitest.e2e.config.ts test/e2e/screenshots.e2e.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { afterEach, expect, it } from 'vitest';
import { encodeJpeg, type Rgb } from '../helpers/fixtures';
import { dropFiles, launch, stubCloseDialog, type Launched, pickTool } from './app';

const out = process.env['SCREENSHOT_DIR'];
let running: Launched | undefined;
afterEach(async () => {
  if (running) await stubCloseDialog(running.app, 0).catch(() => undefined);
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

/** A generated scene: sky, hills and a group of face-like discs with fine detail. */
function scene(width: number, height: number, seed: number): Rgb {
  const data = Buffer.alloc(width * height * 3);
  const faces = [0.22, 0.42, 0.62, 0.8].map((x, i) => ({
    x: x * width,
    y: (0.46 + 0.03 * Math.sin(i + seed)) * height,
    r: height * (0.09 + 0.01 * ((i + seed) % 3)),
  }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = y / height;
      let r = 90 + 120 * t;
      let g = 140 + 70 * t;
      let b = 230 - 60 * t;
      const hill = height * (0.72 + 0.06 * Math.sin((x / width) * 6 + seed));
      if (y > hill) {
        r = 60;
        g = 120 + 30 * Math.sin(x / 90);
        b = 70;
      }
      for (const f of faces) {
        const d = Math.hypot(x - f.x, y - f.y);
        if (d < f.r) {
          const eye =
            Math.hypot(x - f.x + f.r * 0.35, y - f.y + f.r * 0.15) < f.r * 0.12 ||
            Math.hypot(x - f.x - f.r * 0.35, y - f.y + f.r * 0.15) < f.r * 0.12;
          const mouth =
            Math.abs(y - (f.y + f.r * 0.45)) < f.r * 0.06 && Math.abs(x - f.x) < f.r * 0.4;
          r = eye || mouth ? 60 : 224;
          g = eye || mouth ? 40 : 172;
          b = eye || mouth ? 40 : 140;
        } else if (d < f.r * 1.6 && y > f.y) {
          r = 40 + 30 * Math.sin(x / 6);
          g = 50;
          b = 90;
        }
      }
      const i = (y * width + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { width, height, data };
}

async function drag(page: Page, points: Array<[number, number]>): Promise<void> {
  const img = (await page.locator('[data-testid="photo"]').boundingBox())!;
  const at = (p: [number, number]): [number, number] => [
    img.x + p[0] * img.width,
    img.y + p[1] * img.height,
  ];
  await page.mouse.move(...at(points[0]!));
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...at(p), { steps: 6 });
  await page.mouse.up();
}

it.skipIf(!out)(
  'takes the screenshots',
  async () => {
    await mkdir(out!, { recursive: true });
    const dir = await mkdtemp(join(tmpdir(), 'pixlad-shots-'));
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = join(dir, `DSC_${String(1200 + i * 3)}.JPG`);
      await writeFile(path, await encodeJpeg(scene(2400, 1600, i), { quality: 92 }));
      files.push(path);
    }
    running = await launch();
    const { page } = running;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(out!, 'empty-drop-state.png') });

    await dropFiles(page, files);
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    await pickTool(page, 'rect');
    await drag(page, [
      [0.12, 0.3],
      [0.32, 0.62],
    ]); // the first face
    await pickTool(page, 'lasso');
    await drag(page, [
      [0.34, 0.3],
      [0.5, 0.32],
      [0.52, 0.55],
      [0.4, 0.64],
      [0.33, 0.55],
    ]); // the second, freehand
    await pickTool(page, 'rect');
    await drag(page, [
      [0.55, 0.32],
      [0.7, 0.62],
    ]);
    await page.waitForSelector('[data-testid="mosaic-patch"]');
    // Give the preview PNG a moment to decode, and the strip thumbnails to arrive.
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(out!, 'app-with-mosaics.png') });
    expect(await page.locator('[data-testid="area"]').count()).toBe(3);
  },
  120_000,
);
