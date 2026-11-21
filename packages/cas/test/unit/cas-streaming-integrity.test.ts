import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { openCas } from '../../src/cas.js';

// `persistentStatOverrides` makes `stat` answer with a lie for one path on
// EVERY call. `putFile` compares the size it saw before the copy with the
// size it actually copied; when the source keeps changing, both comparisons
// disagree and the publication must refuse instead of storing a torn blob.
const persistentStatOverrides = vi.hoisted(() => new Map<string, () => Stats>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async stat(
      pathLike: Parameters<typeof actual.stat>[0],
      options?: Parameters<typeof actual.stat>[1],
    ) {
      const override = persistentStatOverrides.get(String(pathLike));
      if (override !== undefined) return override();
      return actual.stat(pathLike, options);
    },
  };
});

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-cas-stream-'));
}

/** Drains a stream completely; rejects when the stream errors. */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Drains only the first chunk, the way a consumer that stops early does. */
async function streamFirstChunk(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    break;
  }
  return Buffer.concat(chunks);
}

describe('streaming a blob larger than 10 MB', () => {
  it('streams a 12 MB blob in chunks and verifies it end to end', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const payload = randomBytes(12 * 1024 * 1024);
      const put = await cas.putBytes(payload);
      expect(put.size).toBe(payload.byteLength);

      const chunks: Buffer[] = [];
      for await (const chunk of cas.getStream(put.sha256)) chunks.push(chunk as Buffer);

      // More than one chunk: the blob was streamed, not materialized at once.
      expect(chunks.length).toBeGreaterThan(1);
      const streamed = Buffer.concat(chunks);
      expect(streamed.length).toBe(payload.byteLength);
      expect(createHash('sha256').update(streamed).digest('hex')).toBe(put.sha256);

      // The same blob read whole agrees with the streamed bytes.
      const whole = await cas.get(put.sha256);
      expect(whole.length).toBe(payload.byteLength);
      expect(createHash('sha256').update(whole).digest('hex')).toBe(put.sha256);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('checks the declared size of a 12 MB blob on both read paths', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const payload = randomBytes(12 * 1024 * 1024);
      const put = await cas.putBytes(payload);

      expect((await cas.get(put.sha256, { expectedSize: payload.byteLength })).length).toBe(
        payload.byteLength,
      );
      await expect(
        cas.get(put.sha256, { expectedSize: payload.byteLength + 1 }),
      ).rejects.toThrow(/size mismatch/);
      await expect(
        streamToBuffer(cas.getStream(put.sha256, { expectedSize: payload.byteLength - 1 })),
      ).rejects.toThrow(/size mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('KNOWN BEHAVIOUR: an interrupted stream read skips the integrity check', () => {
  // test-comment (KNOWN RISK, see the bug report): the digest of a streamed
  // blob is verified only AFTER the last chunk was yielded, so a consumer that
  // stops reading early (a preview, a first-chunk sniff, a cancelled read)
  // receives bytes that were never verified. The corruption is reported to
  // whoever drains the stream completely; the early consumer sees plain data.
  it('yields the bytes of a substituted blob without an error when the read stops early', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const payload = randomBytes(4096);
      const put = await cas.putBytes(payload);
      // Substitute the blob: the prefix keeps the original bytes.
      await writeFile(cas.pathFor(put.sha256), Buffer.concat([payload, Buffer.from('tail')]));

      const first = await streamFirstChunk(cas.getStream(put.sha256));

      // No error: the integrity check never ran.
      expect(first.length).toBeGreaterThan(0);
      expect(first.subarray(0, payload.length).equals(payload)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the substitution when the same blob is drained completely', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const payload = randomBytes(4096);
      const put = await cas.putBytes(payload);
      await writeFile(cas.pathFor(put.sha256), Buffer.concat([payload, Buffer.from('tail')]));

      await expect(streamToBuffer(cas.getStream(put.sha256))).rejects.toThrow(
        /integrity check failed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('putFile refuses a source that keeps changing', () => {
  it('throws when the source disagrees with the copy on every pass', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const sourcePath = path.join(root, 'moving-source.bin');
      const payload = Buffer.from('a source that keeps growing');
      await writeFile(sourcePath, payload);

      // The source is rewritten between the stat and the copy, again and again:
      // both passes see a different size than the one that was copied.
      persistentStatOverrides.set(sourcePath, () =>
        ({ size: payload.length + 7, isFile: () => true }) as Stats,
      );

      await expect(cas.putFile(sourcePath)).rejects.toThrow(
        /source file changed while publishing/,
      );

      // Nothing was published and no tmp copy was left behind.
      expect(await readdir(path.join(root, 'cas'))).toEqual([]);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      persistentStatOverrides.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing source without publishing anything', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const missing = path.join(root, 'not-there.bin');

      await expect(cas.putFile(missing)).rejects.toThrow(/ENOENT/);
      expect(await readdir(path.join(root, 'cas'))).toEqual([]);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a source that only disagrees on the first pass', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const sourcePath = path.join(root, 'settling-source.bin');
      const payload = Buffer.from('a source that settled after the first pass');
      await writeFile(sourcePath, payload);

      // The lie holds for the first pass only: the second one sees the real
      // size and the publication succeeds with the copied bytes.
      let calls = 0;
      persistentStatOverrides.set(sourcePath, () => {
        calls += 1;
        return calls === 1
          ? ({ size: payload.length + 3, isFile: () => true }) as Stats
          : ({ size: payload.length, isFile: () => true }) as Stats;
      });

      const put = await cas.putFile(sourcePath);

      expect(put.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
      expect(put.size).toBe(payload.byteLength);
      expect(await cas.get(put.sha256)).toEqual(payload);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      persistentStatOverrides.clear();
      await rm(root, { recursive: true, force: true });
    }
  });
});
