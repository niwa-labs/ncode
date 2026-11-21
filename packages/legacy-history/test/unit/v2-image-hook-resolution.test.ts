import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openCas } from '@mavis/cas';

import {
  isValidBase64,
  openV2Session,
  parseCasSpillRef,
  resolveDefaultCasRoot,
  resolveImageHook,
  type V2Envelope,
  type V2ImportTarget,
} from '../../src/index.js';
import { envelopeLine } from './tmp-session.js';

// The seam between the CAS store and the v2 import: which store the hook
// talks to, where that store puts its blobs, and what the imported envelope
// looks like afterwards. `resolveImageHook` has three branches (an explicit
// store, an explicit root directory, the default durable root) and only the
// default one was covered.

const directories: string[] = [];

function freshDirectory(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function imageLine(data: string, extra: Record<string, unknown> = {}): string {
  return envelopeLine({
    message_id: 'msg-image',
    turn_id: 'turn-1',
    message: { role: 'user', content: [{ type: 'image', data, ...extra }] },
  });
}

function collectingTarget(): { target: V2ImportTarget; envelopes: V2Envelope[] } {
  const envelopes: V2Envelope[] = [];
  return {
    target: {
      putEntry: async (envelope) => {
        envelopes.push(envelope);
      },
    },
    envelopes,
  };
}

describe('resolveImageHook picks the store', () => {
  it('returns no hook for an explicit "keep inline" option', async () => {
    expect(await resolveImageHook(null)).toBeUndefined();
  });

  it('uses a store instance handed in directly', async () => {
    const root = freshDirectory('v2-hook-store-');
    const store = await openCas(root);
    const hook = await resolveImageHook(store);
    expect(hook).toBeDefined();

    const reference = await hook!('aGVsbG8=');
    const parsed = parseCasSpillRef(reference!);
    expect(parsed).not.toBeNull();
    expect(parsed!.size).toBe(5);
    expect(await store.get(parsed!.sha256)).toEqual(Buffer.from('hello', 'utf8'));
  });

  it('opens the store under an explicit root and keeps the documented layout', async () => {
    const root = freshDirectory('v2-hook-root-');
    const hook = await resolveImageHook(root);
    expect(hook).toBeDefined();

    const reference = await hook!('aGVsbG8=');
    const parsed = parseCasSpillRef(reference!);
    expect(parsed).not.toBeNull();

    // `openCas` takes the PARENT root: the blob lands in `<root>/cas/<aa>/...`,
    // never in a `<root>/cas/cas` double nesting.
    const shard = path.join(root, 'cas', parsed!.sha256.slice(0, 2));
    expect(existsSync(shard)).toBe(true);
    expect(await readdir(shard)).toEqual([parsed!.sha256.slice(2)]);
    expect(existsSync(path.join(root, 'cas', 'cas'))).toBe(false);
  });

  it('falls back to the durable root of the current home', async () => {
    const fakeHome = freshDirectory('v2-hook-home-');
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(resolveDefaultCasRoot()).toBe(path.join(fakeHome, '.mcode-durable'));

      const hook = await resolveImageHook(undefined);
      expect(hook).toBeDefined();

      const reference = await hook!('aGVsbG8=');
      const parsed = parseCasSpillRef(reference!);
      const durableShard = path.join(
        fakeHome,
        '.mcode-durable',
        'cas',
        parsed!.sha256.slice(0, 2),
      );
      expect(existsSync(durableShard)).toBe(true);
      // Never the legacy tree.
      expect(existsSync(path.join(fakeHome, '.minimax'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe('huge base64 payloads are handled without crashing', () => {
  it('a payload above ~4.3 MB of base64 characters is validated normally', () => {
    // The strict base64 check handles huge payloads without a backtracking
    // overflow — the regex engine on current Node versions copes with
    // payloads well above the 4.27 MB threshold.
    const huge = 'A'.repeat(5 * 1024 * 1024);
    expect(isValidBase64(huge)).toBe(true);
    // A payload below the limit is validated normally.
    expect(isValidBase64('A'.repeat(4 * 1024 * 1024))).toBe(true);
  }, 30_000);
});

describe('the migrated block', () => {
  it('replaces the inline payload with a reference that resolves to the same bytes', async () => {
    const root = freshDirectory('v2-hook-bytes-');
    const store = await openCas(root);
    const bytes = Buffer.from('the exact bytes of the image', 'utf8');
    const base64 = bytes.toString('base64');
    const dir = freshDirectory('v2-hook-bytes-session-');
    writeFileSync(path.join(dir, 'messages.jsonl'), `${imageLine(base64)}\n`);

    const { target, envelopes } = collectingTarget();
    const stats = await openV2Session(dir).importTo(target, { cas: store });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(1);
    expect(stats.imagesInline).toBe(0);
    expect(stats.imageBlocks).toBe(stats.imagesMigrated + stats.imagesInline);

    const block = envelopes[0]?.message.content?.[0] as { type: string; blob: string };
    expect(block.type).toBe('image_ref');
    const parsed = parseCasSpillRef(block.blob);
    expect(parsed).not.toBeNull();
    expect(parsed!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(parsed!.size).toBe(bytes.byteLength);
    // The store holds exactly those bytes.
    expect(await store.get(parsed!.sha256)).toEqual(bytes);
  });

  it('KNOWN BEHAVIOUR: the migration drops the metadata of the inline block', async () => {
    // test-comment (KNOWN BUG, see the bug report): the migration replaces the
    // WHOLE content block with `{ type: 'image_ref', blob }`. Every other key
    // of the inline block — `mimeType` above all — is dropped, so the
    // imported history no longer says what kind of image the blob is.
    const root = freshDirectory('v2-hook-mime-');
    const store = await openCas(root);
    const dir = freshDirectory('v2-hook-mime-session-');
    writeFileSync(
      path.join(dir, 'messages.jsonl'),
      `${imageLine('aGVsbG8=', { mimeType: 'image/png' })}\n`,
    );

    const { target, envelopes } = collectingTarget();
    const stats = await openV2Session(dir).importTo(target, { cas: store });

    expect(stats.imagesMigrated).toBe(1);
    const block = envelopes[0]?.message.content?.[0] as Record<string, unknown>;
    expect(block['type']).toBe('image_ref');
    expect(block['blob']).toMatch(/^cas:\/\/sha256\/[0-9a-f]{64}#\d+$/u);
    // The mime type of the inline block is gone.
    expect(block['mimeType']).toBeUndefined();
  });

  it('migrates an image whose base64 payload is 2 MB', async () => {
    const root = freshDirectory('v2-hook-large-');
    const store = await openCas(root);
    const bytes = Buffer.alloc(1536 * 1024, 0x5a);
    const base64 = bytes.toString('base64');
    expect(base64.length).toBe(2 * 1024 * 1024);

    const dir = freshDirectory('v2-hook-large-session-');
    writeFileSync(path.join(dir, 'messages.jsonl'), `${imageLine(base64)}\n`);

    const { target, envelopes } = collectingTarget();
    const stats = await openV2Session(dir).importTo(target, { cas: store });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(1);
    expect(stats.imagesInline).toBe(0);
    expect(stats.imageBlocks).toBe(stats.imagesMigrated + stats.imagesInline);

    const block = envelopes[0]?.message.content?.[0] as { type: string; blob: string };
    expect(block.type).toBe('image_ref');
    const parsed = parseCasSpillRef(block.blob);
    expect(parsed).not.toBeNull();
    // The reference describes the DECODED byte count, not the base64 length.
    expect(parsed!.size).toBe(bytes.byteLength);
    expect(parsed!.size).not.toBe(base64.length);
    // The blob in the store is the decoded payload, byte for byte.
    const stored = await store.get(parsed!.sha256);
    expect(stored.length).toBe(bytes.byteLength);
    expect(stored.equals(bytes)).toBe(true);
    // The imported history carries no base64 at all.
    expect(JSON.stringify(envelopes[0])).not.toContain(base64.slice(0, 1024));
  }, 60_000);

  it('a base64 payload above ~4.3 MB is imported without crashing', async () => {
    // The strict base64 check handles huge payloads: the regex engine on
    // current Node versions copes with payloads above the old 4.27 MB
    // backtracking threshold.
    const root = freshDirectory('v2-hook-huge-');
    const store = await openCas(root);
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    const base64 = bytes.toString('base64');
    expect(base64.length).toBeGreaterThan(4.27 * 1024 * 1024);

    const dir = freshDirectory('v2-hook-huge-session-');
    writeFileSync(path.join(dir, 'messages.jsonl'), `${imageLine(base64)}\n`);

    const { target, envelopes } = collectingTarget();
    const stats = await openV2Session(dir).importTo(target, { cas: store });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(1);
  }, 60_000);
});
