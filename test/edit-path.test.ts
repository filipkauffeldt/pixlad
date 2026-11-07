import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseEditPath, editPath } from '../src/main/edit-path';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mr-edit-path-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('edit file names', () => {
  it('adds _edit and keeps the extension case', () => {
    expect(editPath(join(dir, '_DSC1234.JPG'), 1)).toBe(join(dir, '_DSC1234_edit.JPG'));
    expect(editPath(join(dir, 'a.jpg'), 1)).toBe(join(dir, 'a_edit.jpg'));
    expect(editPath(join(dir, 'a.jpeg'), 1)).toBe(join(dir, 'a_edit.jpeg'));
    expect(editPath(join(dir, 'a.Jpeg'), 2)).toBe(join(dir, 'a_edit-2.Jpeg'));
  });

  it('uses .jpg when the source has no JPEG extension', () => {
    expect(editPath(join(dir, 'scan.bin'), 1)).toBe(join(dir, 'scan_edit.jpg'));
    expect(editPath(join(dir, 'noext'), 1)).toBe(join(dir, 'noext_edit.jpg'));
  });

  it('treats a source already named *_edit.jpg as a normal source', () => {
    expect(editPath(join(dir, 'x_edit.jpg'), 1)).toBe(join(dir, 'x_edit_edit.jpg'));
  });
});

describe('choosing the target', () => {
  const source = (): string => join(dir, 'a.jpg');

  it('takes _edit when free', async () => {
    expect(await chooseEditPath(source(), undefined)).toEqual({
      path: join(dir, 'a_edit.jpg'),
      replace: false,
    });
  });

  it('never overwrites a file from an earlier session: _edit-2, _edit-3', async () => {
    await writeFile(join(dir, 'a_edit.jpg'), 'old');
    expect((await chooseEditPath(source(), undefined)).path).toBe(join(dir, 'a_edit-2.jpg'));
    await writeFile(join(dir, 'a_edit-2.jpg'), 'old');
    expect((await chooseEditPath(source(), undefined)).path).toBe(join(dir, 'a_edit-3.jpg'));
  });

  it('replaces the file this session wrote', async () => {
    const path = join(dir, 'a_edit.jpg');
    await writeFile(path, 'mine');
    const info = await stat(path);
    const written = { path, size: info.size, mtimeMs: info.mtimeMs };
    expect(await chooseEditPath(source(), written)).toEqual({ path, replace: true });
  });

  it('does not replace a file that changed since this session wrote it', async () => {
    const path = join(dir, 'a_edit.jpg');
    await writeFile(path, 'mine');
    const info = await stat(path);
    await writeFile(path, 'someone else changed it');
    const written = { path, size: info.size, mtimeMs: info.mtimeMs };
    expect(await chooseEditPath(source(), written)).toEqual({
      path: join(dir, 'a_edit-2.jpg'),
      replace: false,
    });
  });

  it('does not reuse a recorded file that is gone', async () => {
    const written = { path: join(dir, 'a_edit.jpg'), size: 4, mtimeMs: 1 };
    expect((await chooseEditPath(source(), written)).replace).toBe(false);
  });

  it('never targets another source of the session', async () => {
    const other = join(dir, 'a_edit.jpg');
    const result = await chooseEditPath(source(), undefined, new Set([other]));
    expect(result.path).toBe(join(dir, 'a_edit-2.jpg'));
  });
});
