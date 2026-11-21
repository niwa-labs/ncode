import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initLoggingForTests } from '../../src/logger.js';
import {
  _activeTrafficSinkForTests,
  _initTrafficForTests,
  createTrafficSink,
  traffic,
} from '../../src/traffic.js';

function capturedLines(spy: MockInstance<typeof process.stderr.write>): string[] {
  const raw = spy.mock.calls.map((call) => String(call[0])).join('');
  return raw.split('\n').filter((line) => line.length > 0);
}

function base64OfBytes(n: number): { encoded: string; buf: Buffer } {
  const buf = Buffer.alloc(n, 1);
  for (let i = 0; i < n; i += 1) buf[i] = (i * 41) % 256;
  return { encoded: buf.toString('base64'), buf };
}

describe('traffic sink (spec §3)', () => {
  let dir: string;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mavis-logging-traffic-'));
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Default logger config for the sink's internal warn reporting.
    _initLoggingForTests({});
  });

  afterEach(async () => {
    _initTrafficForTests({});
    stderr.mockRestore();
    _initLoggingForTests({});
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op without MCODE_TRAFFIC_LOG', async () => {
    _initTrafficForTests({});
    const unusedPath = path.join(dir, 'never-written.jsonl');
    expect(() => traffic('llm.request', { model: 'gpt' })).not.toThrow();
    await _activeTrafficSinkForTests().flush();
    expect(existsSync(unusedPath)).toBe(false);
    expect(_activeTrafficSinkForTests().pendingCount()).toBe(0);
  });

  it('buffers in memory and writes JSONL lines on flush', async () => {
    const target = path.join(dir, 'traffic.jsonl');
    _initTrafficForTests({ MCODE_TRAFFIC_LOG: target });
    traffic('llm.request', { model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });
    traffic('llm.response', { chunks: 2, usage: { totalTokens: 7 } });
    expect(_activeTrafficSinkForTests().pendingCount()).toBe(2);
    await _activeTrafficSinkForTests().flush();
    const raw = await readFile(target, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { ts: string; event: string; data: unknown };
    const second = JSON.parse(lines[1]!) as { ts: string; event: string; data: unknown };
    expect(first.event).toBe('llm.request');
    expect(first.data).toEqual({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });
    expect(second.event).toBe('llm.response');
    expect(Number.isNaN(Date.parse(first.ts))).toBe(false);
  });

  it('flushes automatically once the queue passes the byte threshold', async () => {
    const target = path.join(dir, 'threshold.jsonl');
    const sink = createTrafficSink({ path: target, full: true, flushThresholdBytes: 16 });
    sink.enqueue('llm.request', { big: 'x'.repeat(64) });
    await sink.flush(); // joins the pending background flush chain
    expect(sink.pendingCount()).toBe(0);
    expect(existsSync(target)).toBe(true);
    await sink.dispose();
  });

  describe('redaction with MCODE_TRAFFIC_LOG_FULL unset', () => {
    it('replaces base64 >256 chars with {redactedBase64:{bytes,sha256}} and always drops secrets', async () => {
      const target = path.join(dir, 'redacted.jsonl');
      _initTrafficForTests({ MCODE_TRAFFIC_LOG: target });
      const { encoded, buf } = base64OfBytes(300);
      traffic('llm.request', {
        image: encoded,
        apiKey: 'sk-secret',
        password: 'hunter2',
        model: 'gpt',
      });
      await _activeTrafficSinkForTests().flush();
      const lines = (await readFile(target, 'utf8')).split('\n').filter((l) => l.length > 0);
      const parsed = JSON.parse(lines[0]!) as {
        data: {
          image: { redactedBase64: { bytes: number; sha256: string } };
          apiKey?: unknown;
          password?: unknown;
          model: string;
        };
      };
      expect(parsed.data.image).toEqual({
        redactedBase64: {
          bytes: 300,
          sha256: createHash('sha256').update(buf).digest('hex').slice(0, 12),
        },
      });
      expect('apiKey' in parsed.data).toBe(false);
      expect('password' in parsed.data).toBe(false);
      expect(parsed.data.model).toBe('gpt');
    });

    it('keeps short strings verbatim', async () => {
      const target = path.join(dir, 'short.jsonl');
      _initTrafficForTests({ MCODE_TRAFFIC_LOG: target });
      traffic('llm.response', { text: 'hello world' });
      await _activeTrafficSinkForTests().flush();
      const parsed = JSON.parse(
        (await readFile(target, 'utf8')).split('\n').filter((l) => l.length > 0)[0]!,
      ) as { data: { text: string } };
      expect(parsed.data.text).toBe('hello world');
    });
  });

  describe('with MCODE_TRAFFIC_LOG_FULL=1', () => {
    it('writes full base64 bodies but still removes secret fields', async () => {
      const target = path.join(dir, 'full.jsonl');
      _initTrafficForTests({ MCODE_TRAFFIC_LOG: target, MCODE_TRAFFIC_LOG_FULL: '1' });
      const { encoded } = base64OfBytes(300);
      traffic('llm.request', { image: encoded, authorization: 'Bearer abc' });
      await _activeTrafficSinkForTests().flush();
      const raw = await readFile(target, 'utf8');
      expect(raw).toContain(encoded);
      expect(raw).not.toContain('Bearer abc');
      const parsed = JSON.parse(raw.trim()) as { data: { image: string; authorization?: unknown } };
      expect(parsed.data.image).toBe(encoded);
      expect('authorization' in parsed.data).toBe(false);
    });
  });

  describe('queue overflow (spec §3)', () => {
    it('drops events past the queue cap, counts them, and warns at the next flush', async () => {
      const target = path.join(dir, 'overflow.jsonl');
      const sink = createTrafficSink({
        path: target,
        full: true,
        flushIntervalMs: 3_600_000,
        flushThresholdBytes: 1_000_000,
        maxQueueBytes: 600,
      });
      sink.enqueue('llm.request', { big: 'x'.repeat(400) }); // ~1 line > cap, admitted once
      for (let i = 0; i < 5; i += 1) sink.enqueue('llm.request', { big: 'y'.repeat(400) });
      expect(sink.droppedCount()).toBe(5);
      await sink.flush();
      const warnOutput = capturedLines(stderr).join('\n');
      expect(warnOutput).toContain('traffic queue overflow');
      expect(warnOutput).toContain('dropped=5');
      // Only the admitted line reached the file.
      const lines = (await readFile(target, 'utf8')).split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"big":"xxx');
      // The counter was reported: the next flush stays quiet.
      const callsBefore = stderr.mock.calls.length;
      await sink.flush();
      expect(stderr.mock.calls.length).toBe(callsBefore);
      await sink.dispose();
    });
  });

  it('never throws on enqueue, even with hostile data', () => {
    const target = path.join(dir, 'hostile.jsonl');
    const sink = createTrafficSink({ path: target, full: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sink.enqueue('llm.request', circular)).not.toThrow();
    expect(() => traffic('llm.request', circular)).not.toThrow();
    expect(() => traffic('llm.request', { bigint: 1n })).not.toThrow();
  });
});
