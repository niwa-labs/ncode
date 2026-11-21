import { createHash } from 'node:crypto';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initLoggingForTests, createLogger } from '../../src/logger.js';
import { base64Stats, isBase64Candidate } from '../../src/render.js';

function capturedLines(spy: MockInstance<typeof process.stderr.write>): string[] {
  const raw = spy.mock.calls.map((call) => String(call[0])).join('');
  return raw.split('\n').filter((line) => line.length > 0);
}

function base64OfBytes(n: number): { encoded: string; buf: Buffer } {
  const buf = Buffer.alloc(n, 1);
  for (let i = 0; i < n; i += 1) buf[i] = (i * 37) % 256;
  return { encoded: buf.toString('base64'), buf };
}

describe('secret field redaction (spec §8)', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _initLoggingForTests({ MCODE_LOG: 'debug', MCODE_LOG_FORMAT: 'json' });
  });

  afterEach(() => {
    stderr.mockRestore();
    _initLoggingForTests({});
  });

  it('drops apiKey/authorization/token/cookie/password top-level fields', () => {
    const log = createLogger('mcode:llm');
    log.info('request', {
      apiKey: 'sk-secret',
      authorization: 'Bearer abc',
      token: 'tok',
      cookie: 'session=1',
      password: 'hunter2',
      model: 'gpt',
    });
    const raw = capturedLines(stderr)[0]!;
    for (const secret of ['sk-secret', 'Bearer abc', 'hunter2', 'session=1', 'tok']) {
      expect(raw).not.toContain(secret);
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['apiKey', 'authorization', 'token', 'cookie', 'password']) {
      expect(key in parsed).toBe(false);
    }
    expect(parsed.model).toBe('gpt');
  });

  it('drops secret-named keys nested inside object fields', () => {
    const log = createLogger('mcode:llm');
    log.debug('payload', { request: { model: 'gpt', apiKey: 'sk-secret', nested: { token: 'tok' } } });
    // Nested object fields are JSON previews (spec §1); secrets are already
    // filtered out of the preview string.
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as { request: string };
    expect(parsed.request).not.toContain('sk-secret');
    expect(parsed.request).not.toContain('"token"');
    expect(parsed.request).toContain('"model":"gpt"');
  });

  it('redacts base64/blob strings >256 chars to {bytes, sha256(12hex)}', () => {
    const { encoded, buf } = base64OfBytes(300);
    expect(encoded.length).toBe(400);
    const log = createLogger('mcode:llm');
    log.debug('image', { image: encoded });
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as {
      image: { bytes: number; sha256: string };
    };
    expect(parsed.image.bytes).toBe(300);
    expect(parsed.image.sha256).toBe(createHash('sha256').update(buf).digest('hex').slice(0, 12));
    expect(parsed.image.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(capturedLines(stderr)[0]).not.toContain(encoded);
  });

  it('leaves short base64 strings and prose untouched (truncates prose >200)', () => {
    const log = createLogger('mcode:llm');
    const short = Buffer.from('hello world').toString('base64');
    const prose = `${'The model replied. '.repeat(30)}Full stop.`;
    log.debug('mixed', { small: short, body: prose });
    const parsed = JSON.parse(capturedLines(stderr)[0]!) as { small: string; body: string };
    expect(parsed.small).toBe(short);
    expect(parsed.body.endsWith('…')).toBe(true);
    expect(parsed.body.length).toBeLessThanOrEqual(201);
  });

  it('base64 helpers behave per the §8 thresholds', () => {
    expect(isBase64Candidate('a'.repeat(256))).toBe(false);
    expect(isBase64Candidate('a'.repeat(257))).toBe(true);
    expect(isBase64Candidate(`${'has, punctuation, in it. '.repeat(20)}`)).toBe(false);
    expect(isBase64Candidate('short')).toBe(false);
    const { encoded, buf } = base64OfBytes(300);
    expect(base64Stats(encoded)).toEqual({
      bytes: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex').slice(0, 12),
    });
  });
});
