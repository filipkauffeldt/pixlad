import { afterEach, describe, expect, it } from 'vitest';
import {
  closeWithoutAsking,
  launch,
  openAbout,
  openPhotos,
  tempDir,
  type Launched,
  writePhoto,
} from './app';

let running: Launched | undefined;
afterEach(async () => {
  await closeWithoutAsking(running);
  running = undefined;
});

describe('About', () => {
  it('shows the copyright, the version and every licence, and blocks shortcuts while open', async () => {
    const dir = await tempDir('pixlad-about-');
    const file = await writePhoto(dir, 'a.jpg', 320, 240);
    running = await launch();
    const { page } = running;
    await openPhotos(page, [file]);

    await openAbout(page);
    const about = page.locator('[data-testid="about"]');
    // The test build has no PIXLAD_VERSION, so it shows the fallback.
    await page.getByText('Version dev', { exact: true }).waitFor();
    expect(await about.innerText()).toContain('Copyright © 2026 Filip Kauffeldt');
    expect(await about.innerText()).toContain('github.com/filipkauffeldt/pixlad');

    await page.click('[data-testid="open-licences"]');
    await page.click('[data-testid="about-gpl"]');
    expect(await about.innerText()).toContain('GNU GENERAL PUBLIC LICENSE');
    await page.locator('.noticeRow', { hasText: /^react \d/ }).click();
    expect(await about.locator('.licenseText').innerText()).toContain(
      'Permission is hereby granted',
    );
    expect(await about.innerText()).toContain('Independent JPEG Group');

    await page.keyboard.press('Delete');
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(1);

    await page.keyboard.press('Escape');
    await about.waitFor({ state: 'detached' });
    expect(await page.locator('[data-testid="thumb"]').count()).toBe(1);
  });
});
