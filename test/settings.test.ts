import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSettings, writeSettings } from '../src/main/settings';
import { DEFAULT_SETTINGS } from '../src/shared/ipc';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixlad-settings-'));
  file = join(dir, 'settings.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the settings file', () => {
  it('gives the defaults when nothing was saved', async () => {
    expect(await readSettings(file)).toEqual({ exportTarget: 'suffix', checkForUpdates: true });
  });

  it('reads back what was written', async () => {
    await writeSettings(file, { exportTarget: 'overwrite', checkForUpdates: false });
    expect(await readSettings(file)).toEqual({ exportTarget: 'overwrite', checkForUpdates: false });
  });

  it('does not hand out the shared defaults object', async () => {
    const settings = await readSettings(file);
    settings.checkForUpdates = false;
    expect(DEFAULT_SETTINGS.checkForUpdates).toBe(true);
  });

  it('reads a file written before the update setting existed', async () => {
    await writeFile(file, '{"exportTarget":"overwrite"}');
    expect(await readSettings(file)).toEqual({ exportTarget: 'overwrite', checkForUpdates: true });
  });
});

describe('the export target setting', () => {
  it.each(['not json', 'null', '[]', '{"exportTarget":"delete"}', '{"exportTarget":true}', ''])(
    'never turns on overwriting from a damaged file: %j',
    async (content) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await writeFile(file, content);
      expect((await readSettings(file)).exportTarget).toBe('suffix');
    },
  );
});

describe('the update check setting', () => {
  it.each(['not json', 'null', '{"checkForUpdates":"no"}', '{"checkForUpdates":0}', ''])(
    'is on when the file is damaged: %j',
    async (content) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await writeFile(file, content);
      expect((await readSettings(file)).checkForUpdates).toBe(true);
    },
  );

  it('is kept next to a damaged export target, and the other way round', async () => {
    await writeFile(file, '{"exportTarget":"delete","checkForUpdates":false}');
    expect(await readSettings(file)).toEqual({ exportTarget: 'suffix', checkForUpdates: false });
    await writeFile(file, '{"exportTarget":"overwrite","checkForUpdates":"x"}');
    expect(await readSettings(file)).toEqual({ exportTarget: 'overwrite', checkForUpdates: true });
  });

  it('is stored as a plain boolean in settings.json', async () => {
    await writeSettings(file, { exportTarget: 'suffix', checkForUpdates: false });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      exportTarget: 'suffix',
      checkForUpdates: false,
    });
  });
});
