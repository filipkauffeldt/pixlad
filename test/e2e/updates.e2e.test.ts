import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launch, type Launched } from './app';

let running: Launched | undefined;
let server: Server;
let base: string;
/** What the fake GitHub does: the latest version it offers, or an error status. */
let latest: { version: string } | { status: number };
let requests: string[];

beforeEach(async () => {
  latest = { version: '0.3.0' };
  requests = [];
  server = createServer((req, res) => {
    // electron-updater adds a cache-busting query.
    const url = new URL(req.url ?? '/', 'http://localhost').pathname;
    requests.push(url);
    if ('status' in latest) {
      res.writeHead(latest.status, { 'Content-Type': 'text/plain' });
      res.end('no');
      return;
    }
    const { version } = latest;
    if (url === '/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          assets: [
            {
              name: `pixlad-${version}-mac-arm64.dmg`,
              browser_download_url: `${base}/download/pixlad-${version}-mac-arm64.dmg`,
              size: 10,
            },
          ],
        }),
      );
    } else if (/^\/latest(-mac|-linux)?\.yml$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      res.end(
        [
          `version: ${version}`,
          'files:',
          `  - url: pixlad-${version}-linux-x86_64.rpm`,
          `    sha512: ${'a'.repeat(86)}==`,
          '    size: 10',
          `path: pixlad-${version}-linux-x86_64.rpm`,
          `sha512: ${'a'.repeat(86)}==`,
          `releaseDate: '2026-01-01T00:00:00.000Z'`,
          '',
        ].join('\n'),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await running?.app.close().catch(() => undefined);
  running = undefined;
  await new Promise((resolve) => server.close(resolve));
});

/** The app thinks it is version 0.2.0 on this system, and asks the fake server. */
const start = async (
  platform: 'darwin' | 'win32' | 'linux',
  options: { userData?: string } = {},
): Promise<Launched> => {
  running = await launch({
    ...options,
    env: { PIXLAD_TEST_UPDATES: JSON.stringify({ url: base, version: '0.2.0', platform }) },
  });
  return running;
};

const openAbout = async (page: Page): Promise<void> => {
  await page.click('[data-testid="settings"]');
  await page.click('[data-testid="open-about"]');
  await page.locator('[data-testid="about"]').waitFor();
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

// macOS asks the GitHub API itself, Windows and Fedora go through electron-updater.
describe.each(['darwin', 'linux'] as const)('updates, as seen on %s', (platform) => {
  it('offers a newer version when the app starts, and Later puts the prompt away', async () => {
    const { page } = await start(platform);
    const prompt = page.locator('[data-testid="update-prompt"]');
    await prompt.waitFor();
    expect(await prompt.locator('[data-testid="update-text"]').innerText()).toBe(
      'Pixlad 0.3.0 is available.',
    );
    expect(await prompt.getByRole('button').allInnerTexts()).toEqual(['Update', 'Later']);
    await page.click('[data-testid="update-later"]');
    await prompt.waitFor({ state: 'detached' });
  });

  it('shows no prompt when the app is up to date, and About says so', async () => {
    latest = { version: '0.2.0' };
    const { page } = await start(platform);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await settle();
    expect(await page.locator('[data-testid="update-prompt"]').count()).toBe(0);

    requests.length = 0;
    await openAbout(page);
    await page.click('[data-testid="about-check-updates"]');
    await page.getByText('Pixlad is up to date', { exact: true }).waitFor();
    expect(requests.length).toBeGreaterThan(0);
  });

  it('never offers an older version', async () => {
    latest = { version: '0.1.0' };
    const { page } = await start(platform);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await settle();
    expect(await page.locator('[data-testid="update-prompt"]').count()).toBe(0);
  });

  it('stays quiet when the start-up check fails, and About gives the reason', async () => {
    latest = { status: 500 };
    const { page } = await start(platform);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    await settle();
    expect(await page.locator('[data-testid="update-prompt"]').count()).toBe(0);
    expect(await page.locator('[data-testid="notice"]').count()).toBe(0);
    expect(await page.locator('[data-testid="toast"]').count()).toBe(0);

    // A second start-up check, with a listener that is there in time, leaves a console warning.
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.reload();
    await page.waitForSelector('[data-testid="toolbar"]');
    await expect
      .poll(() => warnings.some((w) => w.startsWith('Could not check for updates:')))
      .toBe(true);
    expect(await page.locator('[data-testid="update-prompt"]').count()).toBe(0);

    await openAbout(page);
    await page.click('[data-testid="about-check-updates"]');
    const result = page.locator('[data-testid="about-update-result"]');
    await expect.poll(() => result.innerText()).toMatch(/^Could not check for updates: .*500/);
  });

  it('shows a newer version in About with an Update button', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'pixlad-userdata-'));
    await writeFile(join(userData, 'settings.json'), '{"checkForUpdates":false}');
    const { page } = await start(platform, { userData });
    await settle();
    // The setting is off, so nothing was asked and nothing is shown.
    expect(requests).toEqual([]);
    expect(await page.locator('[data-testid="update-prompt"]').count()).toBe(0);

    await openAbout(page);
    await page.click('[data-testid="about-check-updates"]');
    const row = page.locator('[data-testid="about-update"]');
    await row.getByText('Pixlad 0.3.0 is available.', { exact: true }).waitFor();
    expect(await row.getByRole('button').allInnerTexts()).toEqual(['Update']);
    expect(requests.length).toBeGreaterThan(0);
  });
});

describe('updates in a build that does not check', () => {
  it('asks nothing and says so in About', async () => {
    running = await launch();
    const { page } = running;
    await settle();
    expect(await page.locator('[data-testid="update-prompt"]').count()).toBe(0);
    await openAbout(page);
    await page.getByText('This build does not check for updates.').waitFor();
    expect(await page.locator('[data-testid="about-check-updates"]').count()).toBe(0);
    expect(requests).toEqual([]);
  });
});
