import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readExportTarget, writeExportTarget } from '../src/main/settings';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixlad-settings-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the export target setting', () => {
  it('defaults to the suffix when nothing was saved', async () => {
    expect(await readExportTarget(join(dir, 'settings.json'))).toBe('suffix');
  });

  it('reads back what was written', async () => {
    const file = join(dir, 'settings.json');
    await writeExportTarget(file, 'overwrite');
    expect(await readExportTarget(file)).toBe('overwrite');
  });

  it.each(['not json', 'null', '{"exportTarget":"delete"}'])(
    'never turns on overwriting from a damaged file: %s',
    async (content) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const file = join(dir, 'settings.json');
      await writeFile(file, content);
      expect(await readExportTarget(file)).toBe('suffix');
    },
  );
});
