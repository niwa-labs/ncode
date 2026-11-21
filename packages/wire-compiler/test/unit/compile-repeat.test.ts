import { describe, expect, it } from 'vitest';

import {
  COMPILED_RECORD_NORMALIZER_VERSION,
  WireBudgetExceeded,
  compile,
  compiledRecordDialect,
  createLruSegmentCache,
  defaultSegmentCache,
} from '../../src/index.js';
import type { ContextManifest, Entry } from '../../src/types.js';

/**
 * Повторные вызовы компилятора обязаны давать побайтово тот же body: от тела
 * зависит и кэш провайдера, и публикуемый манифест. Кэш сегментов общий на
 * модуль, поэтому «детерминизм» проверяется именно на повторных вызовах.
 */
describe('compile: детерминизм повторных вызовов', () => {
  const entries: Entry[] = [
    { entryId: 'e1', kind: 'text', content: 'first' },
    { entryId: 'e2', kind: 'text', content: 'second' },
  ];
  const manifest: ContextManifest = entries.map((entry) => ({ entryId: entry.entryId }));

  it('50 повторов с одним кэшем дают один и тот же body', () => {
    const cache = createLruSegmentCache(64);
    const bodies = new Set<string>();

    for (let i = 0; i < 50; i += 1) {
      bodies.add(compile(manifest, entries, { maxBytes: 1 << 20, cache }).body.toString('utf8'));
    }

    expect(bodies.size).toBe(1);
  });

  it('повторы не меняют ни body, ни разбивку по сегментам', () => {
    const cache = createLruSegmentCache(64);
    const first = compile(manifest, entries, { maxBytes: 1 << 20, cache });
    const second = compile(manifest, entries, { maxBytes: 1 << 20, cache });

    expect(second.body.equals(first.body)).toBe(true);
    expect(second.totalBytes).toBe(first.totalBytes);
    expect(second.segments.map((segment) => segment.entryId)).toEqual(
      first.segments.map((segment) => segment.entryId),
    );
    expect(second.segments.map((segment) => segment.bytes)).toEqual(
      first.segments.map((segment) => segment.bytes),
    );
  });

  it('тёплый кэш не меняет тело, но снимает хеш (sha256) и чинит cacheHit', () => {
    const cache = createLruSegmentCache(64);
    const cold = compile(manifest, entries, { maxBytes: 1 << 20, cache });
    const warm = compile(manifest, entries, { maxBytes: 1 << 20, cache });

    expect(cold.segments.every((segment) => segment.cacheHit === false)).toBe(true);
    expect(cold.segments.every((segment) => typeof segment.sha256 === 'string')).toBe(true);
    expect(warm.segments.every((segment) => segment.cacheHit === true)).toBe(true);
    expect(warm.segments.every((segment) => segment.sha256 === undefined)).toBe(true);
    expect(warm.body.equals(cold.body)).toBe(true);
  });

  it('requireHashes восстанавливает sha256 на попадании в кэш, тело не меняется', () => {
    const cache = createLruSegmentCache(64);
    const cold = compile(manifest, entries, { maxBytes: 1 << 20, cache });
    const verified = compile(manifest, entries, { maxBytes: 1 << 20, cache, requireHashes: true });

    expect(verified.body.equals(cold.body)).toBe(true);
    expect(verified.segments.map((segment) => segment.sha256)).toEqual(
      cold.segments.map((segment) => segment.sha256),
    );
  });

  it('переплетение двух разных манифестов в одном кэше не смешивает сегменты', () => {
    const cache = createLruSegmentCache(64);
    const other: Entry[] = [{ entryId: 'x1', kind: 'text', content: 'other' }];
    const otherManifest: ContextManifest = [{ entryId: 'x1' }];

    const a1 = compile(manifest, entries, { maxBytes: 1 << 20, cache });
    const b1 = compile(otherManifest, other, { maxBytes: 1 << 20, cache });
    const a2 = compile(manifest, entries, { maxBytes: 1 << 20, cache });

    expect(a2.body.equals(a1.body)).toBe(true);
    expect(b1.body.toString('utf8')).not.toBe(a1.body.toString('utf8'));
    expect(a2.segments.map((segment) => segment.entryId)).toEqual(['e1', 'e2']);
  });

  it('общий кэш по умолчанию переиспользуется между вызовами', () => {
    const entry: Entry = { entryId: 'shared-default-cache', kind: 'text', content: 'shared' };
    const cold = compile([{ entryId: entry.entryId }], [entry], { maxBytes: 1 << 20 });
    const warm = compile([{ entryId: entry.entryId }], [entry], { maxBytes: 1 << 20 });

    expect(cold.segments[0]!.cacheHit).toBe(false);
    expect(warm.segments[0]!.cacheHit).toBe(true);
    expect(warm.body.equals(cold.body)).toBe(true);
    expect(defaultSegmentCache().size).toBeGreaterThan(0);
  });
});

describe('compile: краевые случаи', () => {
  it('пустой манифест даёт пустое тело', () => {
    const compiled = compile([], [], { maxBytes: 1 << 20, cache: createLruSegmentCache(4) });

    expect(compiled.body.length).toBe(0);
    expect(compiled.totalBytes).toBe(0);
    expect(compiled.segments).toEqual([]);
  });

  it('одна гигантская entry компилируется и повторяется побайтово', () => {
    const cache = createLruSegmentCache(4);
    const content = 'x'.repeat(2 * 1024 * 1024);
    const entry: Entry = { entryId: 'giant', kind: 'text', content };
    const manifest: ContextManifest = [{ entryId: 'giant' }];

    const first = compile(manifest, [entry], { maxBytes: 1 << 30, cache });
    const second = compile(manifest, [entry], { maxBytes: 1 << 30, cache });

    expect(first.totalBytes).toBeGreaterThan(content.length);
    expect(second.body.equals(first.body)).toBe(true);
    const verified = compile(manifest, [entry], { maxBytes: 1 << 30, cache, requireHashes: true });
    expect(first.segments[0]!.sha256).toBe(verified.segments[0]!.sha256);
    expect(second.segments[0]!.sha256).toBeUndefined();
  });

  it('бюджетный отказ не оставляет компиляцию в некорректном состоянии', () => {
    const cache = createLruSegmentCache(8);
    const entry: Entry = { entryId: 'e1', kind: 'text', content: 'hello' };
    const manifest: ContextManifest = [{ entryId: 'e1' }];

    expect(() => compile(manifest, [entry], { maxBytes: 1, cache })).toThrow(WireBudgetExceeded);

    const after = compile(manifest, [entry], { maxBytes: 1 << 20, cache });
    expect(after.body.toString('utf8')).toBe('{"role":"user","content":"hello"}\n');
  });

  it('бюджетный отказ не прогревает кэш (сегменты не кэшируются до прохождения бюджета)', () => {
    const cache = createLruSegmentCache(8);
    const entry: Entry = { entryId: 'e1', kind: 'text', content: 'hello' };
    const manifest: ContextManifest = [{ entryId: 'e1' }];

    expect(() => compile(manifest, [entry], { maxBytes: 1, cache })).toThrow(WireBudgetExceeded);
    expect(cache.size).toBe(0);
  });

  it('кэш не различает содержимое при том же entryId (frozen-entry контракт)', () => {
    const cache = createLruSegmentCache(8);
    const manifest: ContextManifest = [{ entryId: 'e1' }];

    const first = compile(manifest, [{ entryId: 'e1', kind: 'text', content: 'first' }], {
      maxBytes: 1 << 20,
      cache,
    });
    const second = compile(manifest, [{ entryId: 'e1', kind: 'text', content: 'SECOND' }], {
      maxBytes: 1 << 20,
      cache,
    });

    // Ключ кэша — (dialect, normalizerVersion, entryId); содержимое в него не входит.
    expect(second.segments[0]!.cacheHit).toBe(true);
    expect(second.body.equals(first.body)).toBe(true);
    expect(second.body.toString('utf8')).toContain('first');
  });
});

describe('compile: инвалидация при смене normalizerVersion', () => {
  it('смена версии диалекта даёт другое пространство кэша и другой результат', () => {
    const cache = createLruSegmentCache(8);
    const manifest: ContextManifest = [{ entryId: 'e1' }];
    const entry: Entry = { entryId: 'e1', kind: 'text', content: 'payload' };

    const v1 = compile(manifest, [entry], {
      maxBytes: 1 << 20,
      cache,
      dialect: { name: 'test-dialect', normalizerVersion: '1', normalizeEntry: (e) => e.content ?? '' },
    });
    const v2 = compile(manifest, [entry], {
      maxBytes: 1 << 20,
      cache,
      dialect: { name: 'test-dialect', normalizerVersion: '2', normalizeEntry: (e) => e.content ?? '' },
    });

    expect(v2.segments[0]!.cacheHit).toBe(false);
    expect(v2.body.equals(v1.body)).toBe(true);
  });

  it('версия нормализатора бриджа совпадает с версией convert-to-llm', () => {
    expect(compiledRecordDialect().normalizerVersion).toBe(COMPILED_RECORD_NORMALIZER_VERSION);
    expect(COMPILED_RECORD_NORMALIZER_VERSION).toBe('2');
  });
});
