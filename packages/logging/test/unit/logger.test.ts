import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initLoggingForTests, createLogger } from '../../src/logger.js';

function capturedOutput(spy: MockInstance<typeof process.stderr.write>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('');
}

describe('createLogger', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _initLoggingForTests({ MCODE_LOG: 'debug' });
  });

  afterEach(() => {
    stderr.mockRestore();
    _initLoggingForTests({});
  });

  it('caches one logger instance per namespace (spec §1)', () => {
    expect(createLogger('mcode:cas')).toBe(createLogger('mcode:cas'));
    expect(createLogger('mcode:cas')).not.toBe(createLogger('mcode:core'));
  });

  it('suppresses events below the namespace level', () => {
    _initLoggingForTests({ MCODE_LOG: 'info' });
    const log = createLogger('mcode:cas');
    log.trace('trace-msg');
    log.debug('debug-msg');
    log.info('info-msg');
    const out = capturedOutput(stderr);
    expect(out).toContain('info-msg');
    expect(out).not.toContain('trace-msg');
    expect(out).not.toContain('debug-msg');
    expect(out.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
  });

  it('emits one stderr line per event above the level', () => {
    const log = createLogger('mcode:cas');
    log.debug('one');
    log.info('two');
    log.warn('three');
    log.error('four');
    expect(stderr.mock.calls).toHaveLength(4);
  });

  it('never throws on circular field objects; marks [circular] (spec §1)', () => {
    const log = createLogger('mcode:cas');
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => log.info('cycle', { obj: circular, arr: [circular] })).not.toThrow();
    const out = capturedOutput(stderr);
    expect(out).toContain('[circular]');
    expect(out.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('never throws when the sink fails', () => {
    stderr.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const log = createLogger('mcode:cas');
    expect(() => log.info('still alive')).not.toThrow();
  });

  it('enabled() is safe and consistent with emission', () => {
    const log = createLogger('mcode:cas');
    expect(log.enabled('debug')).toBe(true);
    expect(log.enabled('trace')).toBe(false);
  });

  describe('child() (spec §1/§6)', () => {
    let jsonStderr: MockInstance<typeof process.stderr.write>;

    beforeEach(() => {
      jsonStderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      _initLoggingForTests({ MCODE_LOG: 'debug', MCODE_LOG_FORMAT: 'json' });
    });

    afterEach(() => {
      jsonStderr.mockRestore();
    });

    it('mixes bound fields into every event', () => {
      const log = createLogger('mcode:turn').child({ sessionId: 's1' });
      log.info('turn start', { turnId: 't1' });
      const line = JSON.parse(capturedOutput(jsonStderr).trim()) as Record<string, unknown>;
      expect(line.sessionId).toBe('s1');
      expect(line.turnId).toBe('t1');
    });

    it('stacks nested children and per-call fields win on conflicts', () => {
      const log = createLogger('mcode:turn').child({ sessionId: 's1' }).child({ turnId: 't1' });
      log.debug('phase', { sessionId: 's2' });
      const line = JSON.parse(capturedOutput(jsonStderr).trim()) as Record<string, unknown>;
      expect(line.sessionId).toBe('s2');
      expect(line.turnId).toBe('t1');
    });

    it('child respects the namespace level filter', () => {
      const log = createLogger('mcode:mmu').child({ sessionId: 's1' });
      _initLoggingForTests({ MCODE_LOG: 'info,mmu:off' });
      expect(() => log.error('suppressed')).not.toThrow();
      expect(capturedOutput(stderr)).toBe('');
    });

    it('child is not cached: each call returns a fresh logger', () => {
      const log = createLogger('mcode:cas');
      expect(log.child({ a: 1 })).not.toBe(log.child({ a: 1 }));
    });
  });
});
