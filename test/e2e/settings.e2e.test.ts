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
