import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initLoggingForTests, createLogger } from '../../src/logger.js';
import {
  PREVIEW_MAX_BYTES,
  STACK_MAX_CHARS,
  STRING_TRUNCATE_CHARS,
  bytePreview,
  coerceLogFieldValue,
  serializeError,
} from '../../src/render.js';

function capturedLines(spy: MockInstance<typeof process.stderr.write>): string[] {
  const raw = spy.mock.calls.map((call) => String(call[0])).join('');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('text format (spec §1)', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _initLoggingForTests({ MCODE_LOG: 'debug', MCODE_LOG_FORMAT: 'text' });
  });

  afterEach(() => {
    stderr.mockRestore();
    _initLoggingForTests({});
  });

  it('renders HH:MM:SS.mmm LEVEL [ns] msg k=v … exactly like the spec sample', () => {
    const log = createLogger('mcode:cas');
    log.info('put', { bytes: 1024, ref: 'ab12cd34ef56', durationMs: 3 });
    const line = capturedLines(stderr)[0]!;
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} INFO {2}\[mcode:cas\] put bytes=1024 ref=ab12cd34ef56 durationMs=3$/);
  });

  it('pads level labels to width 5', () => {
    const log = createLogger('mcode:cas');
    log.error('fatal', { err: new Error('boom') });
    log.warn('degraded');
    log.info('checkpoint');
    const lines = capturedLines(stderr);
    expect(lines[0]).toMatch(/ ERROR \[mcode:cas\] fatal /);
    expect(lines[1]).toMatch(/ WARN {2}\[mcode:cas\] degraded$/);
    expect(lines[2]).toMatch(/ INFO {2}\[mcode:cas\] checkpoint$/);
  });

  it('keeps one line per event even when values contain newlines', () => {
    const log = createLogger('mcode:cas');
    log.info('multi', { note: 'line1\nline2', msg2: 'x' });
    const line = capturedLines(stderr)[0]!;
    expect(line).toContain('line1\\nline2');
    expect(line).not.toMatch(/\n/);
  });

  it('renders object field values as JSON (base64 stats, error info)', () => {
    const buf = Buffer.alloc(300, 7);
    const log = createLogger('mcode:cas');
    log.debug('img', { img: buf.toString('base64') });
    const line = capturedLines(stderr)[0]!;
    expect(line).toMatch(/ img=\{"bytes":300,"sha256":"[0-9a-f]{12}"\}$/);
  });
});

describe('json format (spec §1)', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _initLoggingForTests({ MCODE_LOG: 'debug', MCODE_LOG_FORMAT: 'json' });
  });

  afterEach(() => {
    stderr.mockRestore();
    _initLoggingForTests({});
  });

  it('emits one JSON object per line with ts/level/ns/msg then fields', () => {
    const log = createLogger('mcode:cas');
    log.info('put', { bytes: 1024, ref: 'ab12cd34ef56' });
    const line = capturedLines(stderr)[0]!;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).slice(0, 4)).toEqual(['ts', 'level', 'ns', 'msg']);
    expect(parsed.level).toBe('info');
    expect(parsed.ns).toBe('mcode:cas');
    expect(parsed.msg).toBe('put');
    expect(parsed.bytes).toBe(1024);
    expect(parsed.ref).toBe('ab12cd34ef56');
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.ts as string))).toBe(false);
  });

  it('coerces Error fields to {name, message, stack}', () => {
    const log = createLogger('mcode:cas');
    log.error('fatal', { err: new Error('boom') });
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as { err: { name: string; message: string; stack?: string } };
    expect(parsed.err.name).toBe('Error');
    expect(parsed.err.message).toBe('boom');
    expect(typeof parsed.err.stack).toBe('string');
  });

  it('skips undefined and null fields', () => {
    const log = createLogger('mcode:cas');
    log.info('skip', { a: undefined, b: null, kept: 1 });
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as Record<string, unknown>;
    expect('a' in parsed).toBe(false);
    expect('b' in parsed).toBe(false);
    expect(parsed.kept).toBe(1);
  });

  it('serializes bigint fields as strings', () => {
    const log = createLogger('mcode:cas');
    log.info('big', { seq: 10n });
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as Record<string, unknown>;
    expect(parsed.seq).toBe('10');
  });

  it('previews nested objects to ≤512 bytes with an ellipsis suffix', () => {
    const log = createLogger('mcode:cas');
    log.debug('nested', {
      small: { a: 1 },
      // Inner long strings are truncated (spec §8) inside the preview…
      truncatedInside: { blob: `${'x'.repeat(2000)}!` },
      // …and the whole preview is byte-cut when it exceeds 512 bytes.
      big: { a: 'p'.repeat(195), b: 'q'.repeat(195), c: 'r'.repeat(195), d: 's'.repeat(195) },
    });
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as Record<string, string>;
    expect(parsed.small).toBe('{"a":1}');
    expect(parsed.truncatedInside!).toBe(`{"blob":"${'x'.repeat(200)}…"}`);
    expect(Buffer.byteLength(parsed.truncatedInside!, 'utf8')).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(parsed.big!.startsWith('{"a":"ppp')).toBe(true);
    expect(parsed.big!.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(parsed.big!, 'utf8')).toBe(PREVIEW_MAX_BYTES);
  });

  it('marks cycles inside nested objects as [circular]', () => {
    const log = createLogger('mcode:cas');
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    log.debug('cycle', { obj: circular });
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as { obj: string };
    expect(parsed.obj).toContain('[circular]');
  });
});

describe('field value coercion rules (spec §1/§8)', () => {
  it('truncates long strings to 200 chars with an ellipsis', () => {
    const prose = `Word after word. ${'More of the same sentence, with punctuation. '.repeat(12)}`;
    expect(prose.length).toBeGreaterThan(STRING_TRUNCATE_CHARS);
    expect(coerceLogFieldValue(prose)).toBe(`${prose.slice(0, STRING_TRUNCATE_CHARS)}…`);
    const short = coerceLogFieldValue('short');
    expect(short).toBe('short');
  });

  it('keeps scalars as-is', () => {
    expect(coerceLogFieldValue(42)).toBe(42);
    expect(coerceLogFieldValue(true)).toBe(true);
    expect(coerceLogFieldValue(10n)).toBe('10');
  });

  it('caps Error.stack at 2KB (spec §1)', () => {
    const err = new Error('boom');
    err.stack = `at f (${'x'.repeat(4000)})`;
    const serialized = serializeError(err);
    expect(serialized.name).toBe('Error');
    expect(serialized.message).toBe('boom');
    expect(serialized.stack).toBe('at f (' + 'x'.repeat(STACK_MAX_CHARS - 6) + '…');
    expect(serialized.stack!.length).toBe(STACK_MAX_CHARS + 1);
  });

  it('bytePreview cuts to the byte budget including the ellipsis', () => {
    const ascii = 'a'.repeat(1000);
    expect(Buffer.byteLength(bytePreview(ascii, PREVIEW_MAX_BYTES), 'utf8')).toBe(PREVIEW_MAX_BYTES);
    const multibyte = 'ж'.repeat(1000);
    const cut = bytePreview(multibyte, PREVIEW_MAX_BYTES);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(cut.endsWith('…')).toBe(true);
    expect(bytePreview('tiny', 512)).toBe('tiny');
  });
});
