import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launch, type Launched } from './app';

let running: Launched | undefined;
afterEach(async () => {
  await running?.app.close().catch(() => undefined);
  running = undefined;
});

describe('the update check setting', () => {
  it('is on by default, and a change lasts across a restart', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'pixlad-userdata-'));

    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    expect(await running.page.isChecked('[data-testid="check-for-updates"]')).toBe(true);
    await running.page.click('[data-testid="check-for-updates"]');
    expect(await running.page.isChecked('[data-testid="check-for-updates"]')).toBe(false);
    await running.app.close();
    running = undefined;

    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))).toMatchObject({
      checkForUpdates: false,
    });

    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    await running.page.waitForSelector('[data-testid="check-for-updates"]:not(:checked)');
    // The export setting next to it is untouched.
    expect(await running.page.isChecked('[data-testid="export-target-suffix"]')).toBe(true);

    await running.page.click('[data-testid="check-for-updates"]');
    await running.app.close();
    running = undefined;
    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    await running.page.waitForSelector('[data-testid="check-for-updates"]:checked');
  });
});

describe('the after export setting', () => {
  it('asks by default, and a change lasts across a restart', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'pixlad-userdata-'));

    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    expect(await running.page.isChecked('[data-testid="after-export-ask"]')).toBe(true);
    await running.page.click('[data-testid="after-export-remove"]');
    expect(await running.page.isChecked('[data-testid="after-export-remove"]')).toBe(true);
    // The export target next to it is untouched.
    expect(await running.page.isChecked('[data-testid="export-target-suffix"]')).toBe(true);
    await running.app.close();
    running = undefined;

    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))).toMatchObject({
      afterExport: 'remove',
    });

    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    await running.page.waitForSelector('[data-testid="after-export-remove"]:checked');
  });

  it('is ask when the settings file has no such key', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'pixlad-userdata-'));
    await writeFile(
      join(userData, 'settings.json'),
      JSON.stringify({ exportTarget: 'suffix', exportChosen: true, checkForUpdates: true }),
    );
    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    expect(await running.page.isChecked('[data-testid="after-export-ask"]')).toBe(true);
  });
});

describe('the theme setting', () => {
  const prefersLight = (launched: Launched): Promise<boolean> =>
    launched.page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches);
  const background = (launched: Launched): Promise<string> =>
    launched.page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  it('follows the system by default, switches at once, and lasts across a restart', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'pixlad-userdata-'));

    running = await launch({ userData });
    await running.page.click('[data-testid="settings"]');
    await running.page.waitForSelector('[data-testid="theme-system"][aria-checked="true"]');

    await running.page.click('[data-testid="theme-light"]');
    await running.page.waitForSelector('[data-testid="theme-light"][aria-checked="true"]');
    await expect.poll(() => prefersLight(running!)).toBe(true);
    expect(await background(running)).toBe('rgb(236, 236, 234)');

    await running.page.click('[data-testid="theme-dark"]');
    await expect.poll(() => prefersLight(running!)).toBe(false);
    expect(await background(running)).toBe('rgb(14, 14, 15)');

    // Arrow keys move the choice and stay inside the picker.
    await running.page.keyboard.press('ArrowLeft');
    await running.page.waitForSelector('[data-testid="theme-light"][aria-checked="true"]');
    await running.app.close();
    running = undefined;

    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))).toMatchObject({
      theme: 'light',
    });

    running = await launch({ userData });
    expect(await prefersLight(running)).toBe(true);
    await running.page.click('[data-testid="settings"]');
    await running.page.waitForSelector('[data-testid="theme-light"][aria-checked="true"]');
  });
});
