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

describe('the window', () => {
  it('opens where it was left, and saves where it is left', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'pixlad-userdata-'));
    const saved = { x: 60, y: 50, width: 1100, height: 720, maximized: false };
    await writeFile(
      join(userData, 'settings.json'),
      JSON.stringify({ exportTarget: 'suffix', exportChosen: true, window: saved }),
    );
    running = await launch({ userData });
    const { app } = running;
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getBounds(),
    );
    expect(bounds.width).toBe(saved.width);
    expect(bounds.height).toBe(saved.height);

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 80, y: 70, width: 1000, height: 650 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const written = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as {
      window: { width: number; height: number; maximized: boolean };
    };
    expect(written.window).toMatchObject({ width: 1000, height: 650, maximized: false });
  });
});
