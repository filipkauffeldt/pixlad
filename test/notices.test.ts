import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNotices } from '../src/main/notices';

const file = readFileSync(join(import.meta.dirname, '..', 'THIRD_PARTY_NOTICES.txt'), 'utf8');

describe('the notices shown in About', () => {
  const notices = parseNotices(file);

  it('has one entry per part, with its licence text', () => {
    const react = notices.find((n) => n.title.startsWith('react '));
    expect(react?.title).toMatch(/^react \d+\.\d+\.\d+ \(MIT\)$/);
    expect(react?.homepage).toBe('https://react.dev/');
    expect(react?.text).toContain('Permission is hereby granted');
    const font = notices.find((n) => n.title.startsWith('@fontsource-variable/inter '));
    expect(font?.text).toContain('SIL Open Font License');
  });

  it('includes the parts that are not npm packages, last', () => {
    const titles = notices.map((n) => n.title);
    expect(titles.slice(-4)).toEqual([
      'ONNX Runtime native library (third-party components)',
      'YuNet face detection model (MIT)',
      'Independent JPEG Group',
      'Electron and Chromium (MIT and others)',
    ]);
    expect(notices.find((n) => n.title === 'Independent JPEG Group')?.text).toBe(
      'This software is based in part on the work of the Independent JPEG Group.',
    );
  });

  it('keeps the CRLF and LF forms the same', () => {
    expect(parseNotices(file.replace(/\n/g, '\r\n'))).toEqual(notices);
  });
});
