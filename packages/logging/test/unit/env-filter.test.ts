import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOG_FILTER,
  isSecretKey,
  overrideMatchesNamespace,
  parseLogFilter,
  parseLogFormat,
  resolveNamespaceLevel,
} from '../../src/env.js';
import { _initLoggingForTests, createLogger } from '../../src/logger.js';

describe('parseLogFilter (MCODE_LOG syntax, spec §2)', () => {
  it('defaults to info when unset or empty', () => {
    expect(parseLogFilter(undefined)).toEqual(DEFAULT_LOG_FILTER);
    expect(parseLogFilter('')).toEqual(DEFAULT_LOG_FILTER);
    expect(parseLogFilter('   ')).toEqual(DEFAULT_LOG_FILTER);
  });

  it('parses a bare global level', () => {
    expect(parseLogFilter('debug')).toEqual({ defaultLevel: 'debug', overrides: [] });
  });

  it('parses global level plus prefix overrides', () => {
    const filter = parseLogFilter('info,cas:trace,storage:debug,mmu:off');
    expect(filter.defaultLevel).toBe('info');
    expect(filter.overrides).toEqual([
      { name: 'cas', level: 'trace' },
      { name: 'storage', level: 'debug' },
      { name: 'mmu', level: 'off' },
    ]);
  });

  it('parses the fully-qualified override form (last colon splits)', () => {
    expect(parseLogFilter('info,mcode:mmu:off').overrides).toEqual([
      { name: 'mcode:mmu', level: 'off' },
    ]);
  });

  it('ignores invalid tokens and whitespace', () => {
    const filter = parseLogFilter(' loud , cas : trace , bogus , cas2:nonsense , ,,debug ');
    expect(filter.defaultLevel).toBe('debug');
    expect(filter.overrides).toEqual([{ name: 'cas', level: 'trace' }]);
  });
});

describe('override prefix matching (spec §2)', () => {
  it('matches mcode-prefixed namespaces and their sub-namespaces', () => {
    expect(overrideMatchesNamespace('mcode:cas', 'cas')).toBe(true);
    expect(overrideMatchesNamespace('mcode:cas:sub', 'cas')).toBe(true);
    expect(overrideMatchesNamespace('mcode:mmu', 'mmu')).toBe(true);
  });

  it('does not match namespaces that only share a prefix string', () => {
    expect(overrideMatchesNamespace('mcode:casino', 'cas')).toBe(false);
    expect(overrideMatchesNamespace('mcode:core', 'cas')).toBe(false);
  });

  it('matches verbatim namespaces and the fully-qualified override form', () => {
    expect(overrideMatchesNamespace('mcode:mmu', 'mcode:mmu')).toBe(true);
    expect(overrideMatchesNamespace('mcode:mmu', 'mcode:mmu')).toBe(true);
    expect(overrideMatchesNamespace('mcode:mmu:sub', 'mcode:mmu')).toBe(true);
  });
});

describe('resolveNamespaceLevel', () => {
  it('applies the global default to unmatched namespaces', () => {
    const filter = parseLogFilter('info,cas:trace,mmu:off');
    expect(resolveNamespaceLevel(filter, 'mcode:core')).toBe('info');
  });

  it('applies matching overrides: cas→trace, mmu→off', () => {
    const filter = parseLogFilter('info,cas:trace,storage:debug,mmu:off');
    expect(resolveNamespaceLevel(filter, 'mcode:cas')).toBe('trace');
    expect(resolveNamespaceLevel(filter, 'mcode:storage')).toBe('debug');
    expect(resolveNamespaceLevel(filter, 'mcode:mmu')).toBe('off');
  });

  it('global off disables everything without overrides', () => {
    const filter = parseLogFilter('off');
    expect(resolveNamespaceLevel(filter, 'mcode:cas')).toBe('off');
  });

  it('later matching overrides win', () => {
    const filter = parseLogFilter('info,cas:trace,cas:warn');
    expect(resolveNamespaceLevel(filter, 'mcode:cas')).toBe('warn');
  });
});

describe('enabled() reflects the env filter (spec §2)', () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    _initLoggingForTests({});
  });

  it('default info: info enabled, debug/trace not, warn/error yes', () => {
    _initLoggingForTests({});
    const log = createLogger('mcode:cas');
    expect(log.enabled('info')).toBe(true);
    expect(log.enabled('debug')).toBe(false);
    expect(log.enabled('trace')).toBe(false);
    expect(log.enabled('warn')).toBe(true);
    expect(log.enabled('error')).toBe(true);
  });

  it('override enables trace for cas only', () => {
    _initLoggingForTests({ MCODE_LOG: 'info,cas:trace,mmu:off' });
    const cas = createLogger('mcode:cas');
    const mmu = createLogger('mcode:mmu');
    const core = createLogger('mcode:core');
    expect(cas.enabled('trace')).toBe(true);
    expect(core.enabled('trace')).toBe(false);
    expect(core.enabled('debug')).toBe(false);
    expect(mmu.enabled('error')).toBe(false);
  });

  it('global off disables every level', () => {
    _initLoggingForTests({ MCODE_LOG: 'off' });
    const log = createLogger('mcode:cas');
    for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
      expect(log.enabled(level)).toBe(false);
    }
  });

  it('level cache is invalidated when the env is reinitialized', () => {
    _initLoggingForTests({ MCODE_LOG: 'info' });
    expect(createLogger('mcode:cas').enabled('debug')).toBe(false);
    _initLoggingForTests({ MCODE_LOG: 'debug' });
    expect(createLogger('mcode:cas').enabled('debug')).toBe(true);
  });
});

describe('env helpers', () => {
  it('parseLogFormat accepts json and defaults to text', () => {
    expect(parseLogFormat('json')).toBe('json');
    expect(parseLogFormat('text')).toBe('text');
    expect(parseLogFormat(undefined)).toBe('text');
    expect(parseLogFormat('bogus')).toBe('text');
  });

  it('secret key detection is case-insensitive over the §8 set', () => {
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('Authorization')).toBe(true);
    expect(isSecretKey('token')).toBe(true);
    expect(isSecretKey('cookie')).toBe(true);
    expect(isSecretKey('password')).toBe(true);
    expect(isSecretKey('tokenring')).toBe(false);
    expect(isSecretKey('ref')).toBe(false);
  });
});
