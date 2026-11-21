import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { openCas } from '../../src/cas.js';
import { casSpillRef, parseCasSpillRef } from '../../src/cas-ref.js';

const VALID_DIGEST = 'a'.repeat(64);

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-cas-digest-'));
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('cas rejects invalid digests', () => {
  it('refuses digests that are not 64 hex characters', async () => {
    const store = await openCas(await makeRoot());
    const invalid = [
      '',
      'a',
      'a'.repeat(63),
      'a'.repeat(65),
      'z'.repeat(64),
      'a'.repeat(63) + 'g',
      '0x' + 'a'.repeat(62),
      'a'.repeat(32) + ' ' + 'a'.repeat(31),
      'a'.repeat(63) + '\n',
      'a'.repeat(64) + '\0',
    ];
    for (const digest of invalid) {
      expect(() => store.pathFor(digest)).toThrow(/invalid SHA-256 digest/);
      expect(() => store.has(digest)).toThrow(/invalid SHA-256 digest/);
      await expect(store.hasAsync(digest)).rejects.toThrow(/invalid SHA-256 digest/);
      await expect(store.get(digest)).rejects.toThrow(/invalid SHA-256 digest/);
    }
  });

  it('refuses traversal-prone digest input', async () => {
    const store = await openCas(await makeRoot());
    const traversal = [
      '../../../../etc/passwd',
      '..%2f..%2fetc%2fpasswd',
      '../'.repeat(8) + 'secret',
      '/etc/shadow',
    ];
    for (const digest of traversal) {
      expect(() => store.pathFor(digest)).toThrow(/invalid SHA-256 digest/);
      await expect(store.get(digest)).rejects.toThrow(/invalid SHA-256 digest/);
    }
  });

  it('normalizes an uppercase digest to the lowercase blob path', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('uppercase-digest', 'utf8');
    const { sha256 } = await store.putBytes(payload);

    const uppercase = sha256.toUpperCase();
    expect(store.pathFor(uppercase)).toBe(store.pathFor(sha256));
    expect(await store.hasAsync(uppercase)).toBe(true);
    expect(await store.get(uppercase)).toEqual(payload);
  });

  it('surfaces an invalid digest on the stream path only when the stream is consumed', async () => {
    // The generator validates lazily: building the stream must not throw, the
    // failure has to arrive as a stream error, exactly like a missing blob.
    const store = await openCas(await makeRoot());
    let stream: Readable | undefined;
    expect(() => {
      stream = store.getStream('not-a-digest');
    }).not.toThrow();
    await expect(streamToBuffer(stream!)).rejects.toThrow(/invalid SHA-256 digest/);
  });
});

describe('cas:// reference parsing', () => {
  it('rejects references that are not canonical', () => {
    const foreign = [
      '',
      'not-a-reference',
      `cas://sha256/${VALID_DIGEST}`,
      `cas://sha256/${VALID_DIGEST}#`,
      `cas://sha256/${VALID_DIGEST}#12x`,
      `cas://sha256/${VALID_DIGEST}#-1`,
      `cas://sha256/${VALID_DIGEST}#1.5`,
      `cas://sha256/${VALID_DIGEST}#1#2`,
      `cas://sha256/${VALID_DIGEST}#1 `,
      ` cas://sha256/${VALID_DIGEST}#1`,
      `cas://sha256/${VALID_DIGEST.toUpperCase()}#1`,
      `cas://sha256/${'a'.repeat(63)}#1`,
      `cas://sha256/${'a'.repeat(65)}#1`,
      `cas://sha256/${'z'.repeat(64)}#1`,
      `cas://sha1/${VALID_DIGEST}#1`,
      `file://sha256/${VALID_DIGEST}#1`,
      `cas://sha256/${VALID_DIGEST}#1\n`,
    ];
    for (const reference of foreign) {
      expect(parseCasSpillRef(reference), reference).toBeNull();
    }
  });

  it('round-trips a reference built from a real digest and size', async () => {
    const store = await openCas(await makeRoot());
    const payload = Buffer.from('round-trip', 'utf8');
    const { sha256, size } = await store.putBytes(payload);
    const reference = casSpillRef(sha256, size);

    expect(parseCasSpillRef(reference)).toEqual({ sha256, size });
  });

  it('does not round-trip a reference built from an invalid digest', () => {
    // The builder is unchecked: a foreign digest produces a reference no
    // parser accepts, so a broken producer can never be mistaken for a valid
    // one by a reader.
    expect(parseCasSpillRef(casSpillRef('not-a-digest', 10))).toBeNull();
    expect(parseCasSpillRef(casSpillRef('a'.repeat(64), -1))).toBeNull();
  });

  it('accepts a declared size of zero for an empty blob', async () => {
    const store = await openCas(await makeRoot());
    const { sha256, size } = await store.putBytes(new Uint8Array(0));
    expect(size).toBe(0);
    expect(parseCasSpillRef(casSpillRef(sha256, size))).toEqual({ sha256, size: 0 });
  });

  it('parses an absurdly long size into a non-finite number', () => {
    // test-comment (KNOWN BUG, see the bug report): the size field is parsed
    // with `Number(...)` and the pattern accepts an unbounded digit run, so a
    // hostile reference yields `size: Infinity` instead of a rejected
    // reference — the size silently stops describing bytes.
    const reference = `cas://sha256/${VALID_DIGEST}#${'9'.repeat(400)}`;
    const parsed = parseCasSpillRef(reference);
    expect(parsed).not.toBeNull();
    expect(parsed!.size).toBe(Infinity);
    expect(Number.isFinite(parsed!.size)).toBe(false);
  });

  it('loses precision for a size above the safe integer range', () => {
    // test-comment (KNOWN BUG, see the bug report): two different declared
    // sizes collapse onto the same parsed number, so the size in a reference
    // cannot be trusted to identify a byte count exactly.
    const declared = '9007199254740993'; // 2^53 + 1, not representable as a double
    const parsed = parseCasSpillRef(`cas://sha256/${VALID_DIGEST}#${declared}`);
    expect(parsed!.size).toBe(2 ** 53);
    // The declared byte count is not the parsed byte count.
    expect(String(parsed!.size)).not.toBe(declared);
  });

  it('keeps the digest of a reference independent of the size field', async () => {
    const store = await openCas(await makeRoot());
    const payload = Buffer.from('digest-is-independent', 'utf8');
    const expected = createHash('sha256').update(payload).digest('hex');
    expect(parseCasSpillRef(casSpillRef(expected, 0))!.sha256).toBe(expected);
  });
});
