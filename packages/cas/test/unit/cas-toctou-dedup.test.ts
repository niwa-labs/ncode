import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { openCas } from '../../src/cas.js';

// The dedup path of `putBytes` is a probe-then-commit sequence: the blob is
// probed with an async `stat` and, when the probe says "missing", the bytes
// are published through an exclusive hard link. `staleProbes` makes that probe
// answer "missing" for a blob that is on disk, so the commit lands on an
// occupied slot (EEXIST) — the exact window a real concurrent publisher opens
// between the probe and the link.
const staleProbes = vi.hoisted(() => new Set<string>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async stat(pathLike: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) {
      if (staleProbes.delete(String(pathLike))) {
        const stale = new Error(`stale probe: ${String(pathLike)}`) as NodeJS.ErrnoException;
        stale.code = 'ENOENT';
        throw stale;
      }
      return actual.stat(pathLike, options);
    },
  };
});

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-cas-toctou-'));
}

function blobPath(root: string, sha256: string): string {
  return path.join(root, 'cas', sha256.slice(0, 2), sha256.slice(2));
}

async function tmpEntries(root: string): Promise<string[]> {
  return readdir(path.join(root, 'tmp'));
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('cas dedup race between the existence probe and the exclusive commit', () => {
  it('concurrent publishers of the same content converge on one blob and leave no tmp file', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('toctou-race-payload'.repeat(64), 'utf8');
    const expected = createHash('sha256').update(payload).digest('hex');

    const results = await Promise.all(Array.from({ length: 8 }, () => store.putBytes(payload)));

    for (const result of results) {
      expect(result.sha256).toBe(expected);
      expect(result.size).toBe(payload.byteLength);
    }
    // One blob, holding exactly the published bytes.
    expect(await store.get(expected)).toEqual(payload);
    const shard = path.join(root, 'cas', expected.slice(0, 2));
    expect(await readdir(shard)).toEqual([expected.slice(2)]);
    // Every losing publisher dropped its tmp copy.
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('two independent store instances on one root race without corrupting the blob', async () => {
    const root = await makeRoot();
    const first = await openCas(root);
    const second = await openCas(root);
    const payload = Buffer.from('two-store-instances', 'utf8');
    const expected = createHash('sha256').update(payload).digest('hex');

    const [a, b] = await Promise.all([first.putBytes(payload), second.putBytes(payload)]);

    expect(a.sha256).toBe(expected);
    expect(b.sha256).toBe(expected);
    expect(await first.get(expected)).toEqual(payload);
    expect(await second.get(expected)).toEqual(payload);
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('keeps the winner bytes when the blob appears between the probe and the commit', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('published-by-another-writer', 'utf8');
    const expected = createHash('sha256').update(payload).digest('hex');

    // Another writer published the digest first; the probe of this publisher
    // still answers "missing" (the stale view a TOCTOU race produces).
    await mkdir(path.dirname(blobPath(root, expected)), { recursive: true });
    await writeFile(blobPath(root, expected), payload);

    const result = await store.putBytes(payload);

    // With rename semantics the losing publisher atomically replaces the
    // winner — but since both files carry identical bytes (same SHA-256),
    // the replacement is semantically transparent.
    expect(result.sha256).toBe(expected);
    expect(result.size).toBe(payload.byteLength);
    const after = await readFile(blobPath(root, expected));
    expect(after).toEqual(payload);
    expect(await store.get(expected)).toEqual(payload);
    // The loser of the race leaves no tmp residue behind.
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('never rewrites an existing blob on a dedup hit', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('dedup-hit', 'utf8');
    const first = await store.putBytes(payload);
    const before = await stat(blobPath(root, first.sha256));

    const second = await store.putBytes(payload);

    expect(second.sha256).toBe(first.sha256);
    const after = await stat(blobPath(root, first.sha256));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('keeps the bytes intact when putFile and putBytes publish the same content', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('file-vs-bytes-race'.repeat(100), 'utf8');
    const expected = createHash('sha256').update(payload).digest('hex');
    const source = path.join(root, 'source.bin');
    await writeFile(source, payload);

    const [fromBytes, fromFile] = await Promise.all([store.putBytes(payload), store.putFile(source)]);

    expect(fromBytes.sha256).toBe(expected);
    expect(fromFile.sha256).toBe(expected);
    expect(fromBytes.size).toBe(payload.byteLength);
    expect(fromFile.size).toBe(payload.byteLength);
    expect(await store.get(expected)).toEqual(payload);
    expect(await tmpEntries(root)).toEqual([]);
  });
});

describe('cas dedup fast path is content-blind', () => {
  it('reports success for a planted blob at the digest path without repairing it', async () => {
    // test-comment (KNOWN BEHAVIOUR, see the bug report): the dedup fast path
    // trusts the *existence* of the blob path, never its content. A file
    // planted at the digest path (another process, a restored backup, a
    // hostile writer with write access to the store) is adopted as "already
    // published": `putBytes` reports success for bytes it never wrote, and
    // the substitution is only detected when the blob is read back.
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('honest-payload', 'utf8');
    const sha256 = createHash('sha256').update(payload).digest('hex');

    await mkdir(path.dirname(blobPath(root, sha256)), { recursive: true });
    await writeFile(blobPath(root, sha256), 'substituted-bytes');

    const result = await store.putBytes(payload);

    expect(result.sha256).toBe(sha256);
    expect(result.size).toBe(payload.byteLength);
    // The planted file was adopted, not overwritten.
    expect(await readFile(blobPath(root, sha256), 'utf8')).toBe('substituted-bytes');
    // The read fails loudly instead of serving the substituted bytes.
    await expect(store.get(sha256)).rejects.toThrow(/integrity check failed/);
  });

  it('reports a blob that vanishes between the existence probe and the read', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('vanishes-between-probe-and-read', 'utf8');
    const { sha256 } = await store.putBytes(payload);

    expect(await store.hasAsync(sha256)).toBe(true);
    await rm(blobPath(root, sha256));
    expect(await store.hasAsync(sha256)).toBe(false);
    await expect(store.get(sha256)).rejects.toThrow(/blob not found in CAS/);
    await expect(streamToBuffer(store.getStream(sha256))).rejects.toThrow(/blob not found in CAS/);
  });
});
