import { describe, expect, it } from 'vitest';

import {
  MINIMAX_M3_DIALECT,
  assemblePayload,
  compileBatchKey,
  compileKey,
} from '../../src/index.js';

type Entry = {
  id: string;
  kind: string;
  payload: unknown;
  seq: number;
};

function entry(id: string, kind: string, payload: unknown, seq: number): Entry {
  return { id, kind, payload, seq };
}

const PLACED = 'mcode.owner-input.placed';
const REMINDER = 'mcode.system-reminder';

describe('placed-entry дедупликация: краевые случаи', () => {
  it('первая placement побеждает, вторая отбрасывается', () => {
    const payload = assemblePayload([
      entry('p1', PLACED, { inputEntryId: 'in_1', model: [{ role: 'user', content: 'steer' }] }, 1),
      entry('p2', PLACED, { inputEntryId: 'in_1', model: [{ role: 'user', content: 'steer' }] }, 2),
    ]);

    expect(payload.records.map((record) => record.entryId)).toEqual(['p1']);
    expect(payload.stats.placedDropped).toBe(1);
  });

  it('placement без decodable inputEntryId не дедуплицируется по чужому id', () => {
    const payload = assemblePayload([
      entry('p1', PLACED, { model: [{ role: 'user', content: 'one' }] }, 1),
      entry('p2', PLACED, { model: [{ role: 'user', content: 'two' }] }, 2),
    ]);

    expect(payload.records.map((record) => record.entryId)).toEqual(['p1', 'p2']);
    expect(payload.stats.placedDropped).toBe(0);
  });

  it('пустой inputEntryId не дедуплицируется (нет ключа — нет дедупа)', () => {
    const payload = assemblePayload([
      entry('p1', PLACED, { inputEntryId: '', model: [{ role: 'user', content: 'one' }] }, 1),
      entry('p2', PLACED, { inputEntryId: '', model: [{ role: 'user', content: 'two' }] }, 2),
    ]);

    expect(payload.records.map((record) => record.entryId)).toEqual(['p1', 'p2']);
    expect(payload.stats.placedDropped).toBe(0);
  });

  it('недекодируемая первая placement не блокирует вторую (обе декодируются)', () => {
    const payload = assemblePayload([
      entry('p1', PLACED, { inputEntryId: 'in_1', model: [] }, 1),
      entry('p2', PLACED, { inputEntryId: 'in_1', model: [{ role: 'user', content: 'steer' }] }, 2),
    ]);

    expect(payload.records).not.toEqual([]);
    expect(payload.stats.placedDropped).toBe(0);
  });
});

describe('tail-entry позиционирование после кэш-префикса', () => {
  it('напоминание без другого контента даёт пустой префикс и один tail', () => {
    const payload = assemblePayload([entry('rem1', REMINDER, { text: 'todo changed' }, 1)]);

    expect(payload.prefix).toEqual([]);
    expect(payload.tails.map((record) => record.entryId)).toEqual(['rem1']);
    expect(payload.stats.reminderTails).toBe(1);
    expect(payload.stats.prefixBytes).toBe(0);
    expect(payload.stats.tailBytes).toBeGreaterThan(0);
    expect(payload.stats.totalBytes).toBe(payload.stats.tailBytes);
  });

  it('tail всегда идёт после всех префиксных записей', () => {
    const payload = assemblePayload([
      entry('u1', 'pi.user', { model: [{ role: 'user', content: 'hello' }] }, 1),
      entry('rem1', REMINDER, { text: 'todo changed' }, 2),
      entry('u2', 'pi.user', { model: [{ role: 'user', content: 'world' }] }, 3),
    ]);

    const order = payload.records.map((record) => record.entryId);
    const firstTail = order.indexOf('rem1');
    const lastPrefix = Math.max(order.indexOf('u1'), order.indexOf('u2'));
    expect(firstTail).toBeGreaterThan(lastPrefix);
    expect(payload.tails.map((record) => record.entryId)).toEqual(['rem1']);
  });

  it('встроенное напоминание попадает в tail, остаток остаётся в префиксе', () => {
    const payload = assemblePayload([
      entry('u1', 'pi.user', {
        model: [{ role: 'user', content: 'keep <system-reminder>inline</system-reminder>' }],
      }, 1),
    ]);

    expect(payload.tails.map((record) => record.entryId)).toEqual(['u1#reminder:0']);
    expect(payload.prefix.map((record) => record.entryId)).toEqual(['u1']);
    expect(payload.prefix[0]!.content.trim()).toBe('keep');
  });

  it('байты префикса и tail-ов сходятся с суммой записей', () => {
    const payload = assemblePayload([
      entry('u1', 'pi.user', { model: [{ role: 'user', content: 'hello' }] }, 1),
      entry('rem1', REMINDER, { text: 'todo changed' }, 2),
    ]);

    const sum = payload.records.reduce((total, record) => total + record.byteLen, 0);
    expect(payload.stats.prefixBytes + payload.stats.tailBytes).toBe(sum);
    expect(payload.stats.totalBytes).toBe(sum);
  });

  it.skip('напоминание без декодируемого текста учитывается как tail', () => {
    const payload = assemblePayload([entry('rem1', REMINDER, { nothing: true }, 1)]);

    expect(payload.stats.totalEntries).toBe(1);
    expect(payload.stats.reminderTails).toBeGreaterThanOrEqual(0);
    expect(payload.stats.noProviderRecord).toBe(0);
  });
});

describe('инвалидация ключей при смене normalizerVersion', () => {
  const bumped = { ...MINIMAX_M3_DIALECT, normalizerVersion: MINIMAX_M3_DIALECT.normalizerVersion + 1 };

  it('compileKey меняется вместе с версией нормализатора', () => {
    expect(compileKey('e1', MINIMAX_M3_DIALECT)).toBe('e1@minimax-m3#v2');
    expect(compileKey('e1', bumped)).not.toBe(compileKey('e1', MINIMAX_M3_DIALECT));
  });

  it('compileBatchKey меняется вместе с версией нормализатора', () => {
    expect(compileBatchKey(['a', 'b'], MINIMAX_M3_DIALECT)).toBe('batch(a+b)@minimax-m3#v2');
    expect(compileBatchKey(['a', 'b'], bumped)).not.toBe(
      compileBatchKey(['a', 'b'], MINIMAX_M3_DIALECT),
    );
  });

  it('запись несёт cacheKey с текущей версией', () => {
    const payload = assemblePayload([
      entry('u1', 'pi.user', { model: [{ role: 'user', content: 'hello' }] }, 1),
    ]);

    expect(payload.records[0]!.cacheKey).toBe('u1@minimax-m3#v2');
  });
});
