import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeWithoutAsking, launch, tempDir, type Launched } from './app';

let running: Launched | undefined;
afterEach(async () => {
  await closeWithoutAsking(running);
  running = undefined;
});

describe('the window', () => {
  it('opens where it was left, and saves where it is left', async () => {
    const userData = await tempDir('pixlad-userdata-');
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
    // The size is saved a moment after the last resize.
    const written = async (): Promise<unknown> =>
      (JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as { window: unknown })
        .window;
    await expect
      .poll(written, { timeout: 10_000 })
      .toMatchObject({ width: 1000, height: 650, maximized: false });
  });

  it.skipIf(process.platform === 'darwin')(
    'keeps the top bar clear of the window buttons drawn over it',
    async () => {
      running = await launch();
      const { page } = running;
      const { settingsRight, buttonsLeft } = await page.evaluate(() => {
        // The strip of the top bar that the window buttons do not cover.
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:0;left:0;width:env(titlebar-area-width, 100vw)';
        document.body.append(probe);
        const free = probe.getBoundingClientRect().width;
        probe.remove();
        const settings = document.querySelector('[data-testid="settings"]')!;
        return { settingsRight: settings.getBoundingClientRect().right, buttonsLeft: free };
      });
      expect(buttonsLeft).toBeLessThan(1440);
      expect(settingsRight).toBeLessThanOrEqual(buttonsLeft);
    },
  );
});
