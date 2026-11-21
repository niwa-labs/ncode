import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCas } from '../../src/cas.js';

// `putBase64` is the CAS entry point for base64 payloads. Its contract (see
// the module header of `src/cas.ts`) says the decoding "is lenient (it mirrors
// `Buffer.from(base64, 'base64')`)" and that "the digest covers the decoded
// bytes". The tests below pin that contract for the payloads that reach it in
// production (canonical base64) and characterize the one case where the
// chunked decoder and the one-shot decoder disagree.
//
// The chunked decoder (`putBase64`) cuts the payload into 4-char-aligned
// pieces, so it can only reproduce `Buffer.from` while the 4-char quantum of
// the SOURCE string is preserved. A payload that contains characters outside
// the base64 alphabet shifts the quantum of everything after the first such
// character, and the two decoders then produce different bytes for the very
// same input.

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-cas-b64-'));
}

function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('putBase64 mirrors Buffer.from for canonical payloads', () => {
  it('stores the decoded bytes and reports their digest and size', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const bytes = Buffer.concat([Buffer.from([0x00, 0xff, 0x10]), randomBytes(97)]);
      const base64 = bytes.toString('base64');

      const put = await cas.putBase64(base64);

      // The digest covers the DECODED bytes, not the base64 text.
      expect(put.sha256).toBe(sha256Of(bytes));
      expect(put.size).toBe(bytes.byteLength);
      expect(put.size).not.toBe(base64.length);
      expect(await cas.get(put.sha256)).toEqual(bytes);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('agrees with putBytes on the same payload, so both paths dedup onto one blob', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const bytes = randomBytes(1024);
      const base64 = bytes.toString('base64');

      const viaBase64 = await cas.putBase64(base64);
      const viaBytes = await cas.putBytes(bytes);

      expect(viaBase64.sha256).toBe(viaBytes.sha256);
      expect(viaBase64.size).toBe(viaBytes.size);
      // One blob: the second publication was a dedup hit.
      const shard = path.join(root, 'cas', viaBase64.sha256.slice(0, 2));
      expect(await readdir(shard)).toEqual([viaBase64.sha256.slice(2)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the digest stable across the 64 KiB decode-chunk boundary', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      // 48 KiB of bytes -> 64 KiB of base64 chars: exactly one decode chunk.
      const atBoundary = randomBytes(48 * 1024);
      const acrossBoundary = randomBytes(48 * 1024 + 1);

      for (const bytes of [atBoundary, acrossBoundary]) {
        const base64 = bytes.toString('base64');
        const put = await cas.putBase64(base64);
        expect(put.sha256, `payload of ${bytes.byteLength} bytes`).toBe(sha256Of(bytes));
        expect(put.size).toBe(bytes.byteLength);
        expect(await cas.get(put.sha256)).toEqual(bytes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('decodes a payload whose base64 text is larger than 10 MB', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      // 9 MiB of bytes -> 12 MiB of base64 characters: the string the CAS has
      // to decode is well past 10 MB, and the decoded blob is a fresh 9 MiB.
      const bytes = randomBytes(9 * 1024 * 1024);
      const base64 = bytes.toString('base64');
      expect(base64.length).toBeGreaterThan(10 * 1024 * 1024);

      const put = await cas.putBase64(base64);

      expect(put.sha256).toBe(sha256Of(bytes));
      expect(put.size).toBe(bytes.byteLength);
      // The blob on disk is the decoded payload, not the base64 text.
      const stored = await cas.get(put.sha256);
      expect(stored.length).toBe(bytes.byteLength);
      expect(sha256Of(stored)).toBe(put.sha256);
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('KNOWN BEHAVIOUR: putBase64 diverges from Buffer.from on non-canonical input', () => {
  // test-comment (KNOWN BUG, see the bug report): the documented contract
  // ("it mirrors `Buffer.from(base64, 'base64')`") does not hold for payloads
  // whose invalid characters shift the 4-char quantum. The chunked decoder
  // drops the invalid characters from the PIECE it decodes and carries the
  // remainder over, while `Buffer.from` drops them from the WHOLE string and
  // then decodes the surviving characters as one run — two different byte
  // strings for the same input, hence two different digests.
  it('decodes fewer bytes than Buffer.from when the payload carries a space', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const payload = 'QUFB QUFB'; // "AAAA" split by a space
      const whole = Buffer.from(payload, 'base64');

      const put = await cas.putBase64(payload);

      // The one-shot decoder yields 6 bytes, the chunked one 5.
      expect(whole.length).toBe(6);
      expect(put.size).toBe(5);
      expect(put.sha256).not.toBe(sha256Of(whole));
      expect((await cas.get(put.sha256)).length).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('decodes fewer bytes than Buffer.from when the payload carries a newline', async () => {
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const payload = 'QUFB\nQUFB';
      const whole = Buffer.from(payload, 'base64');

      const put = await cas.putBase64(payload);

      expect(whole.length).toBe(6);
      expect(put.size).toBe(5);
      expect(put.sha256).not.toBe(sha256Of(whole));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the divergence invisible for canonical payloads (the production path)', async () => {
    // The image hook validates strict canonical base64 BEFORE it stores
    // anything, so the divergent branch is unreachable for the v2 import: the
    // payload the hook hands to the store decodes identically either way.
    const root = await makeRoot();
    try {
      const cas = await openCas(root);
      const bytes = randomBytes(4096);
      const canonical = bytes.toString('base64');
      expect(canonical).toMatch(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/u);

      const viaBase64 = await cas.putBase64(canonical);
      const viaBytes = await cas.putBytes(bytes);

      expect(viaBase64.sha256).toBe(sha256Of(Buffer.from(canonical, 'base64')));
      expect(viaBase64.sha256).toBe(viaBytes.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
