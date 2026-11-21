import { describe, expect, it } from 'vitest';
import {
  getTuiTerminalImagePasteFallbackPath,
  isTuiTerminalImagePaste,
  resolveTuiTerminalPasteReferences,
  splitTuiTerminalPastePaths,
} from '../../src/tui/features/composer/terminal-image-paste.js';

describe('terminal image paste', () => {
  it.each([
    '/tmp/otty-paste/image-123.png',
    '"/var/folders/demo/T/otty-paste/image-123.webp"',
    '/workspace/image-123.avif',
    'C:\\Users\\demo\\AppData\\Local\\Temp\\otty-paste\\image-123.jpg',
    "'D:\\Yingyong\\social\\wechat\\xwechat_files\\wxid_demo\\temp\\RWTemp\\2026-08\\image.png'",
  ])('recognizes pasted absolute image paths: %s', (value) => {
    expect(isTuiTerminalImagePaste(value)).toBe(true);
  });

  it.each([
    'workspace/image-123.png',
    '/tmp/otty-paste/notes.txt',
    '/tmp/otty-paste/image-1.png\nsecond line',
  ])('leaves ordinary pasted text untouched: %s', (value) => {
    expect(isTuiTerminalImagePaste(value)).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)('decodes escaped spaces in %s image paths', (platform) => {
    expect(
      getTuiTerminalImagePasteFallbackPath(
        '/Users/bee/Screen\\ shots/Screenshot\\ 2026-09-17\\ at\\ 18.03.36.png',
        platform,
      ),
    ).toBe('/Users/bee/Screen shots/Screenshot 2026-09-17 at 18.03.36.png');
  });

  it.each([
    ['win32', '/workspace/Screenshot\\ 2026.png'],
    ['darwin', 'C:\\Users\\bee\\ Screenshot.png'],
    ['darwin', '\\\\server\\share\\ Screenshot.png'],
    ['darwin', '//server/share/\\ Screenshot.png'],
    ['darwin', "'/Users/bee/Screenshot\\ 2026.png'"],
    ['darwin', '"/Users/bee/Screenshot\\ 2026.png"'],
    ['darwin', '/Users/bee/Screenshot 2026.png'],
    ['darwin', '/Users/bee/Screenshot\\ 2026.png\nmore text'],
  ] as const)('preserves literal path syntax on %s: %s', (platform, value) => {
    expect(getTuiTerminalImagePasteFallbackPath(value, platform)).toBeUndefined();
  });
});

describe('multi-file Finder drops (space-separated path paste)', () => {
  it('splits a 3-file drop into individual decoded paths', () => {
    const value =
      '/Users/bee/Downloads/screenshot-2026-08-21-13-51-36.png /Users/bee/Downloads/screenshot-2026-09-02-14-46-03.png /Users/bee/Downloads/screenshot-2026-09-07-16-53-12.png';
    expect(splitTuiTerminalPastePaths(value)).toEqual([
      '/Users/bee/Downloads/screenshot-2026-08-21-13-51-36.png',
      '/Users/bee/Downloads/screenshot-2026-09-02-14-46-03.png',
      '/Users/bee/Downloads/screenshot-2026-09-07-16-53-12.png',
    ]);
    // The whole drop is an attachment paste (the OLD detector stat'ed the
    // concatenation and failed with ENOENT — the owner's live bug).
    expect(isTuiTerminalImagePaste(value)).toBe(true);
  });

  it('keeps escaped spaces inside a filename and splits on bare ones', () => {
    expect(
      splitTuiTerminalPastePaths(
        '/Users/bee/Screen\\ shots/a\\ b.png /Users/bee/plain.png',
      ),
    ).toEqual(['/Users/bee/Screen shots/a b.png', '/Users/bee/plain.png']);
  });

  it('preserves backslashes that are path separators, not escapes (Windows)', () => {
    expect(splitTuiTerminalPastePaths('C:\\Users\\demo\\shots\\image.png')).toEqual([
      'C:\\Users\\demo\\shots\\image.png',
    ]);
    expect(isTuiTerminalImagePaste('C:\\Users\\demo\\shots\\image.png')).toBe(true);
  });

  it('a mixed drop (image + non-image) is NOT an attachment paste', () => {
    expect(
      isTuiTerminalImagePaste('/tmp/a.png /tmp/notes.txt'),
    ).toBe(false);
  });

  it('multiline pastes still split into nothing', () => {
    expect(splitTuiTerminalPastePaths('/tmp/a.png\n/tmp/b.png')).toEqual([]);
    expect(isTuiTerminalImagePaste('/tmp/a.png\n/tmp/b.png')).toBe(false);
  });
});

describe('paste reference resolution (multi-drop vs single-path ambiguity)', () => {
  it('a 3-file drop resolves to three references, not the concatenation', () => {
    expect(
      resolveTuiTerminalPasteReferences(
        '/Users/bee/a.png /Users/bee/b.png /Users/bee/c.png',
      ),
    ).toEqual(['/Users/bee/a.png', '/Users/bee/b.png', '/Users/bee/c.png']);
  });

  it('an unquoted Windows path with spaces stays ONE reference', () => {
    expect(
      resolveTuiTerminalPasteReferences('D:\\Users\\demo\\Documents\\Screen shots\\截图.png'),
    ).toEqual(['D:\\Users\\demo\\Documents\\Screen shots\\截图.png']);
  });

  it('a single escaped-space path keeps the escaped form for the fallback decoder', () => {
    expect(
      resolveTuiTerminalPasteReferences('/Users/bee/Screen\\ shots/a\\ b.png'),
    ).toEqual(['/Users/bee/Screen\\ shots/a\\ b.png']);
  });

  it('a single QUOTED path is passed through verbatim (the resolver strips quotes itself)', () => {
    expect(
      resolveTuiTerminalPasteReferences("'D:\\Yingyong\\shots\\image.png'"),
    ).toEqual(["'D:\\Yingyong\\shots\\image.png'"]);
  });

  it('plain text resolves to nothing', () => {
    expect(resolveTuiTerminalPasteReferences('hello world')).toBeUndefined();
    expect(resolveTuiTerminalPasteReferences('/tmp/a.png /tmp/notes.txt')).toBeUndefined();
  });
});
