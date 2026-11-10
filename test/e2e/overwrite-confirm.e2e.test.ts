import type { Page } from '@playwright/test';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeJpeg, syntheticPhoto } from '../helpers/fixtures';
import { dropFiles, launch, stubCloseDialog, type Launched } from './app';

let running: Launched | undefined;
afterEach(async () => {
  if (running) await stubCloseDialog(running.app, 0).catch(() => undefined);
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'pixlad-e2e-'));
const dialog = '[data-testid="overwrite-confirm"]';

async function photo(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, await encodeJpeg(syntheticPhoto(1200, 900)));
  return path;
}

/** A user data folder of someone who chose Replace original earlier. */
async function replacingUser(): Promise<string> {
  const userData = await tmp();
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ exportTarget: 'overwrite', exportChosen: true }),
  );
  return userData;
}

async function drawRect(page: Page): Promise<void> {
  const box = (await page.locator('[data-testid="photo"]').boundingBox())!;
  await page.click('[data-tool="rect"]');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid="mosaic-patch"]');
}

describe('confirming Replace original', () => {
  it('leaves the file alone on Cancel, with the focus on Cancel, and writes on Replace', async () => {
    const dir = await tmp();
    const file = await photo(dir, 'one.jpg');
    const before = await readFile(file);
    running = await launch({ userData: await replacingUser() });
    const { page } = running;
    await dropFiles(page, [file]);
    await page.waitForSelector('[data-testid="photo"]');
    await drawRect(page);

    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector(dialog);
    expect(await page.locator(dialog).innerText()).toContain('one.jpg');
    expect(await page.locator(dialog).innerText()).toContain('This cannot be undone.');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'overwrite-confirm-cancel',
    );

    await page.keyboard.press('Escape');
    await page.waitForSelector(dialog, { state: 'detached' });
    expect(Buffer.compare(await readFile(file), before)).toBe(0);

    await page.click('[data-testid="export"]');
    await page.click('[data-testid="overwrite-confirm-replace"]');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30_000 });
    expect(Buffer.compare(await readFile(file), before)).not.toBe(0);
    expect(await readdir(dir)).toEqual(['one.jpg']);
  });

  it('asks from Export all with the number of photos', async () => {
    const dir = await tmp();
    const one = await photo(dir, 'one.jpg');
    const two = await photo(dir, 'two.jpg');
    running = await launch({ userData: await replacingUser() });
    const { page } = running;
    await dropFiles(page, [one, two]);
    await page.waitForSelector('[data-testid="photo"]');
    await drawRect(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('[data-testid="photo"]');
    await drawRect(page);

    await page.click('[data-testid="export-all"]');
    await page.waitForSelector(dialog);
    const text = await page.locator(dialog).innerText();
    expect(text).toContain('Replace 2 originals?');
    expect(text).toContain('one.jpg');
    expect(text).toContain('two.jpg');
    expect(await page.locator('[data-testid="overwrite-confirm-replace"]').innerText()).toBe(
      'Replace 2',
    );
  });

  it('does not ask again this session when ticked, but asks again after a restart', async () => {
    const dir = await tmp();
    const userData = await replacingUser();
    const one = await photo(dir, 'one.jpg');
    const two = await photo(dir, 'two.jpg');
    running = await launch({ userData });
    let { page } = running;
    await dropFiles(page, [one, two]);
    await page.waitForSelector('[data-testid="photo"]');
    await drawRect(page);

    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector(dialog);
    await page.check('[data-testid="overwrite-confirm-dont-ask"]');
    await page.click('[data-testid="overwrite-confirm-replace"]');
    await page.waitForSelector('[data-testid="badge-exported"]', { timeout: 30_000 });

    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('[data-testid="photo"]');
    await drawRect(page);
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="badge-exported"]').length === 2,
      undefined,
      { timeout: 30_000 },
    );
    expect(await page.locator(dialog).count()).toBe(0);

    await stubCloseDialog(running.app, 0);
    await running.app.close();
    running = await launch({ userData });
    ({ page } = running);
    await dropFiles(page, [one]);
    await page.waitForSelector('[data-testid="photo"]');
    await drawRect(page);
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForSelector(dialog);
  });
});
