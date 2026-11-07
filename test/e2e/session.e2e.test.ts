import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adobeRgbProfile,
  encodeJpeg,
  iccSegments,
  syntheticPhoto,
  withSegments,
} from '../helpers/fixtures';
import {
  dialogMessages,
  dropFiles,
  launch,
  removeMessages,
  stubCloseDialog,
  stubRemoveDialog,
  type Launched,
} from './app';

let running: Launched | undefined;
afterEach(async () => {
  if (running) await stubCloseDialog(running.app, 0).catch(() => undefined);
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

const tmp = (prefix = 'pixlad-e2e-'): Promise<string> => mkdtemp(join(tmpdir(), prefix));
const photoReady = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="photo"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
const box = async (page: Page): Promise<{ x: number; y: number; w: number; h: number }> => {
  const b = (await page.locator('[data-testid="photo"]').boundingBox())!;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};
async function drawRect(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const b = await box(page);
  await page.mouse.move(b.x + from[0] * b.w, b.y + from[1] * b.h);
  await page.mouse.down();
  await page.mouse.move(b.x + to[0] * b.w, b.y + to[1] * b.h, { steps: 6 });
  await page.mouse.up();
}
const photoFile = async (dir: string, name: string, w = 1600, h = 1200): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, await encodeJpeg(syntheticPhoto(w, h)));
  return path;
};

describe('opening', () => {
  it('refuses non-JPEG and CMYK files with messages that name them, and opens the rest', async () => {
    const dir = await tmp();
    const ok = await photoFile(dir, 'fine.jpg');
    const png = join(dir, 'logo.png');
    await writeFile(
      png,
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
    );
    const cmyk = join(dir, 'press.jpg');
    const raw = syntheticPhoto(64, 48);
    await writeFile(
      cmyk,
      await sharp(raw.data, { raw: { width: 64, height: 48, channels: 3 } })
        .toColourspace('cmyk')
        .jpeg()
        .toBuffer(),
    );
    running = await launch();
    const { page } = running;
    await dropFiles(page, [png, cmyk, ok]);
    await photoReady(page);
    const notice = await page.locator('[data-testid="notice"]').first().innerText();
    expect(notice).toContain('"logo.png" is not a JPEG file');
    expect(notice).toContain('"press.jpg"');
    expect(notice).toContain('CMYK');
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(1);
  });

  it('shows the empty drop state, then a strip of photos that the arrow keys step through', async () => {
    const dir = await tmp();
    const files = [
      await photoFile(dir, 'a.jpg'),
      await photoFile(dir, 'b.jpg'),
      await photoFile(dir, 'c.jpg'),
    ];
    running = await launch();
    const { page } = running;
    expect(await page.locator('[data-testid="empty"]').count()).toBe(1);
    await dropFiles(page, files);
    await photoReady(page);
    const current = (): Promise<string | null> =>
      page.locator('[data-testid="thumb"][aria-current="true"]').getAttribute('data-name');
    expect(await current()).toBe('a.jpg');
    await page.keyboard.press('ArrowRight');
    expect(await current()).toBe('b.jpg');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await current()).toBe('c.jpg');
    await page.keyboard.press('ArrowLeft');
    expect(await current()).toBe('b.jpg');
  });

  it('takes hundreds of photos from a folder drop and keeps the window responsive', async () => {
    const dir = await tmp();
    const folder = join(dir, 'big');
    await mkdir(folder);
    const jpeg = await encodeJpeg(syntheticPhoto(96, 64));
    for (let i = 0; i < 250; i++)
      await writeFile(join(folder, `p${String(i).padStart(3, '0')}.jpg`), jpeg);
    running = await launch();
    const { page } = running;
    await dropFiles(page, [folder]);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="footer"]')?.textContent?.includes('1 / 250'),
      undefined,
      { timeout: 30000 },
    );
    // Only what is on screen is in the DOM.
    expect(await page.locator('[data-testid="thumb"]').count()).toBeLessThan(40);
    // The page answers while thumbnails are decoded.
    const before = Date.now();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
    expect(Date.now() - before).toBeLessThan(1000);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="footer"]')?.textContent?.includes('2 / 250'),
    );
  });

  it('removes a photo from the session only: the file stays', async () => {
    const dir = await tmp();
    const a = await photoFile(dir, 'a.jpg');
    await photoFile(dir, 'b.jpg');
    running = await launch();
    const { page } = running;
    await dropFiles(page, [a, join(dir, 'b.jpg')]);
    await photoReady(page);
    await page.locator('[data-testid="thumb"][data-name="a.jpg"]').hover();
    await page.locator('[data-testid="thumb"][data-name="a.jpg"] [data-testid="remove"]').click();
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(1);
    await page.keyboard.press('Delete');
    await page.waitForSelector('[data-testid="empty"]');
    expect((await readdir(dir)).sort()).toEqual(['a.jpg', 'b.jpg']);
  });
});

describe('zoom and pan', () => {
  it('toggles Fit and 100% on Z, snaps 100% to the device pixel grid, zooms with Ctrl, and pans', async () => {
    const dir = await tmp();
    const file = await photoFile(dir, 'z.jpg', 2400, 1600);
    running = await launch();
    const { page } = running;
    await dropFiles(page, [file]);
    await photoReady(page);
    const stage = page.locator('[data-testid="stage"]');
    expect(await stage.getAttribute('data-fit')).toBe('true');
    await page.mouse.move(700, 400);
    await page.keyboard.press('z');
    expect(await stage.getAttribute('data-fit')).toBe('false');
    const b = await box(page);
    expect(b.w).toBe(2400); // 100%: one image pixel per device pixel
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const left = await page
      .locator('[data-testid="photo"]')
      .evaluate((el) => parseFloat((el as HTMLElement).style.left));
    expect(Number.isInteger(left * dpr)).toBe(true);
    expect(await page.locator('[data-testid="footer"]').innerText()).toContain('100%');

    // pan with the wheel and with Space + drag
    const x0 = (await box(page)).x;
    await page.mouse.wheel(120, 0);
    await page.waitForTimeout(100);
    expect((await box(page)).x).not.toBe(x0);
    const x1 = (await box(page)).x;
    await page.keyboard.down('Space');
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(540, 400, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    expect(Math.round((await box(page)).x - x1)).toBe(-60);
    expect(await page.locator('[data-testid="area"]').count()).toBe(0); // Space-drag draws nothing

    // Ctrl + plus zooms in, Ctrl + minus back out, Z returns to Fit
    await page.keyboard.press('Control+=');
    expect((await box(page)).w).toBeGreaterThan(2400);
    await page.keyboard.press('Control+-');
    await page.keyboard.press('z');
    expect(await stage.getAttribute('data-fit')).toBe('true');
    // Ctrl + wheel
    await page.mouse.move(700, 400);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await page.waitForTimeout(100);
    expect(await stage.getAttribute('data-fit')).toBe('false');
  });
});

describe('closing and exporting a batch', () => {
  it('asks once with the count when mosaics are not exported, and not after exporting', async () => {
    const dir = await tmp();
    const files = [
      await photoFile(dir, 'one.jpg'),
      await photoFile(dir, 'two.jpg'),
      await photoFile(dir, 'three.jpg'),
    ];
    running = await launch();
    const { app, page } = running;
    await dropFiles(page, files);
    await photoReady(page);
    await page.click('[data-tool="rect"]');
    for (let i = 0; i < 3; i++) {
      await drawRect(page, [0.2, 0.2], [0.5, 0.5]);
      if (i < 2) {
        await page.keyboard.press('ArrowRight');
        await photoReady(page);
      }
    }
    await stubCloseDialog(app, 1); // Cancel
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await dialogMessages(app)).toEqual(['3 photos have unexported mosaics. Close anyway?']);
    expect(await page.locator('[data-testid="toolbar"]').count()).toBe(1); // still open

    await page.click('[data-testid="export-all"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="batch-status"]')?.textContent ===
        '3 exported, 0 failed',
      undefined,
      { timeout: 60000 },
    );
    expect((await readdir(dir)).sort()).toEqual([
      'one.jpg',
      'one_edit.jpg',
      'three.jpg',
      'three_edit.jpg',
      'two.jpg',
      'two_edit.jpg',
    ]);
    // Nothing left to lose: closing does not ask again.
    const asked = (await dialogMessages(app)).length;
    await stubCloseDialog(app, 0);
    await app.close();
    running = undefined;
    expect(asked).toBe(1);
  });

  it('exports all with one failure: counts, names the failed file, and does not stop the rest', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = await tmp();
    const locked = join(dir, 'locked');
    await mkdir(locked);
    const good = await photoFile(dir, 'good.jpg');
    const bad = await photoFile(locked, 'bad.jpg');
    const good2 = await photoFile(dir, 'good2.jpg');
    await chmod(locked, 0o555);
    try {
      running = await launch();
      const { app, page } = running;
      await stubRemoveDialog(app, 0);
      await dropFiles(page, [good, bad, good2]);
      await photoReady(page);
      await page.click('[data-tool="rect"]');
      for (let i = 0; i < 3; i++) {
        await drawRect(page, [0.3, 0.3], [0.6, 0.6]);
        if (i < 2) {
          await page.keyboard.press('ArrowRight');
          await photoReady(page);
        }
      }
      await page.click('[data-testid="export-all"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="batch-status"]')?.textContent ===
          '2 exported, 1 failed',
        undefined,
        { timeout: 60000 },
      );
      const toast = await page.locator('[data-testid="toast"]').first().innerText();
      expect(toast).toContain('bad.jpg');
      expect(await readdir(dir)).toEqual(
        expect.arrayContaining(['good_edit.jpg', 'good2_edit.jpg']),
      );
      expect(await readdir(locked)).toEqual(['bad.jpg']);
      // Only the photos that made it are offered; the failed one stays to be dealt with.
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="strip"] img').length === 1,
      );
      expect(await removeMessages(app)).toEqual(['Remove 2 exported photos from the session?']);
      expect((await readdir(dir)).sort()).toEqual(
        expect.arrayContaining(['good.jpg', 'good2.jpg']),
      );
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('can keep working while a batch exports: edits after a photo started do not change that export', async () => {
    const dir = await tmp();
    const file = await photoFile(dir, 'busy.jpg');
    running = await launch();
    const { page } = running;
    await dropFiles(page, [file]);
    await photoReady(page);
    await page.click('[data-tool="rect"]');
    await drawRect(page, [0.2, 0.2], [0.4, 0.4]);
    await page.click('[data-testid="export-all"]');
    await drawRect(page, [0.6, 0.6], [0.8, 0.8]); // drawn while the export runs
    await page.waitForSelector('[data-testid="badge-exported"], [data-testid="batch-status"]', {
      timeout: 30000,
    });
    expect(await page.locator('[data-testid="area"]').count()).toBe(2);
  });
});

describe('after an export', () => {
  const exportOne = async (page: Page, name: string, dir: string): Promise<string> => {
    const file = await photoFile(dir, name);
    await dropFiles(page, [file]);
    await photoReady(page);
    await page.click('[data-tool="rect"]');
    await drawRect(page, [0.2, 0.2], [0.5, 0.5]);
    await page.waitForSelector('[data-testid="mosaic-patch"]');
    await page.keyboard.press('Control+e');
    return file;
  };

  it('asks about a single photo: Remove takes it out of the session, the files stay', async () => {
    const dir = await tmp();
    running = await launch();
    const { app, page } = running;
    await stubRemoveDialog(app, 0);
    await exportOne(page, 'single.jpg', dir);
    await page.waitForSelector('[data-testid="empty"]', { timeout: 30000 });
    expect(await removeMessages(app)).toEqual(['Remove single.jpg from the session?']);
    expect((await readdir(dir)).sort()).toEqual(['single.jpg', 'single_edit.jpg']);
  });

  it('asks about a single photo: Keep leaves it in the session', async () => {
    const dir = await tmp();
    running = await launch();
    const { app, page } = running;
    await exportOne(page, 'kept.jpg', dir);
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30000 });
    await expect.poll(() => removeMessages(app)).toEqual(['Remove kept.jpg from the session?']);
    expect(await page.locator('[data-testid="photo"]').count()).toBe(1);
  });

  it('does not offer to remove a photo edited while it was exporting', async () => {
    const dir = await tmp();
    running = await launch();
    const { app, page } = running;
    await stubRemoveDialog(app, 0);
    await exportOne(page, 'edited.jpg', dir);
    await drawRect(page, [0.6, 0.6], [0.8, 0.8]); // drawn while the export runs
    await page.waitForFunction(
      () => document.querySelector('[data-testid="photo-status"]')?.textContent?.includes('Saved'),
      undefined,
      { timeout: 30000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await removeMessages(app)).toEqual([]);
    expect(await page.locator('[data-testid="photo"]').count()).toBe(1);
  });
});

describe('overwriting the original', () => {
  it('replaces the file, clears the areas, shows the file again and remembers the choice', async () => {
    const dir = await tmp();
    const userData = await tmp('pixlad-userdata-');
    const file = await photoFile(dir, 'over.jpg');
    const before = await readFile(file);

    running = await launch({ userData });
    const { app, page } = running;
    await page.click('[data-testid="settings"]');
    expect(await page.isChecked('[data-testid="export-target-suffix"]')).toBe(true);
    await page.click('[data-testid="export-target-overwrite"]');
    await page.keyboard.press('Escape');
    expect(await page.locator('[data-testid="settings-panel"]').count()).toBe(0);

    await dropFiles(page, [file]);
    await photoReady(page);
    await page.click('[data-tool="rect"]');
    await drawRect(page, [0.2, 0.2], [0.5, 0.5]);
    await page.waitForSelector('[data-testid="mosaic-patch"]');
    await page.keyboard.press('Control+e');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30000 });

    expect(await readdir(dir)).toEqual(['over.jpg']);
    expect(Buffer.compare(await readFile(file), before)).not.toBe(0);
    expect(await page.locator('[data-testid="area"]').count()).toBe(0);
    expect(await page.locator('[data-testid="badge-mosaic"]').count()).toBe(0);
    expect(await page.isDisabled('[data-testid="export"]')).toBe(true);
    expect(await page.getAttribute('[data-testid="photo"]', 'src')).toContain('?v=1');
    await photoReady(page);

    await stubCloseDialog(app, 0);
    await app.close();
    running = undefined;

    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    await running.page.waitForSelector('[data-testid="export-target-overwrite"]:checked');
  });
});

describe('the window', () => {
  it('has no menu bar on Windows and Linux', async () => {
    if (process.platform === 'darwin') return; // the macOS menu is outside the window
    running = await launch();
    expect(await running.app.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull();
  });
});

describe('nothing survives the session', () => {
  it('starts empty after a restart and writes nothing outside the exported _edit files', async () => {
    const dir = await tmp();
    const tmpDir = await tmp('pixlad-apptmp-');
    const userData = await tmp('pixlad-userdata-');
    const marker = 'session-marker-4f7a91';
    const file = await photoFile(dir, `${marker}.jpg`);
    const sourceBytes = await readFile(file);

    running = await launch({ userData, env: { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir } });
    const { app } = running;
    let { page } = running;
    await dropFiles(page, [file]);
    await photoReady(page);
    await page.click('[data-tool="rect"]');
    await drawRect(page, [0.2, 0.2], [0.5, 0.5]);
    await page.keyboard.press('Control+e');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30000 });
    await stubCloseDialog(app, 0);
    await app.close();
    running = undefined;

    // Only the source and its export are in the photo's folder; the source is untouched.
    expect((await readdir(dir)).sort()).toEqual([`${marker}.jpg`, `${marker}_edit.jpg`]);
    expect(Buffer.compare(await readFile(file), sourceBytes)).toBe(0);

    // No file in the app's data or temp folders mentions the photo or its areas.
    const hits: string[] = [];
    const scan = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await scan(path);
        else if (entry.isFile() && (await stat(path)).size < 64 * 1024 * 1024) {
          const bytes = await readFile(path).catch(() => Buffer.alloc(0));
          if (path.includes(marker) || bytes.includes(marker)) hits.push(path);
        }
      }
    };
    await scan(userData);
    await scan(tmpDir);
    expect(hits).toEqual([]);

    // A fresh start with the same profile folder is empty.
    running = await launch({ userData, env: { TMPDIR: tmpDir } });
    page = running.page;
    expect(await page.locator('[data-testid="empty"]').count()).toBe(1);
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('colour on screen', () => {
  it('shows the mosaic preview in the same colour as the Adobe RGB photo under it', async () => {
    const dir = await tmp();
    const width = 1200;
    const height = 800;
    const data = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      data[i * 3] = 0; // saturated green: out of sRGB gamut once Adobe RGB is applied
      data[i * 3 + 1] = 200;
      data[i * 3 + 2] = 60;
    }
    const base = await encodeJpeg({ width, height, data }, { quality: 98, subsampling: '4:4:4' });
    const file = join(dir, 'adobe.jpg');
    await writeFile(file, withSegments(base, iccSegments(adobeRgbProfile())));
    running = await launch();
    const { page } = running;
    await dropFiles(page, [file]);
    await photoReady(page);
    await page.click('[data-tool="rect"]');
    await drawRect(page, [0.3, 0.3], [0.7, 0.7]);
    await page.waitForSelector('[data-testid="mosaic-patch"]');
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="mosaic-patch"]');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    await page.mouse.move(5, 5);
    // The outline's 5% tint is chrome, not photo: look at the pixels without it.
    await page.addStyleTag({ content: '.overlay { display: none }' });
    const b = await box(page);
    const shot = await page.screenshot();
    const raw = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number): number[] => {
      const i = (Math.round(y) * raw.info.width + Math.round(x)) * 3;
      return [raw.data[i]!, raw.data[i + 1]!, raw.data[i + 2]!];
    };
    const outside = at(b.x + 0.1 * b.w, b.y + 0.5 * b.h);
    const inside = at(b.x + 0.5 * b.w, b.y + 0.5 * b.h);
    // The patch and the photo go through the same profile: no seam.
    for (let c = 0; c < 3; c++) expect(Math.abs(outside[c]! - inside[c]!)).toBeLessThanOrEqual(2);
    // And the profile really is applied: the screen differs from the stored values (0, 200, 60).
    expect(Math.max(...outside.map((v, c) => Math.abs(v - [0, 200, 60][c]!)))).toBeGreaterThan(8);
  });
});
