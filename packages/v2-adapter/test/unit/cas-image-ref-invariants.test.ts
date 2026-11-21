import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCas } from '@mavis/cas';

import {
  createCasImageHook,
  isValidBase64,
  openV2Session,
  parseCasSpillRef,
  CasSpillError,
  type CasImportIssue,
  type CasStoreLike,
  type ImportStats,
  type V2Envelope,
  type V2ImportTarget,
} from '../../src/index.js';
import { envelopeLine } from './tmp-session.js';

const HELLO_B64 = 'aGVsbG8=';
const HELLO_BYTES = Buffer.from('hello', 'utf8');

/** A store double that records the bytes it received and can fail on demand. */
class RecordingStore implements CasStoreLike {
  readonly calls: Uint8Array[] = [];

  constructor(private readonly failure?: (bytes: Uint8Array) => Error | undefined) {}

  async putBytes(data: Uint8Array): Promise<{ readonly sha256: string; readonly size: number }> {
    this.calls.push(data);
    const failure = this.failure?.(data);
    if (failure !== undefined) throw failure;
    return { sha256: createHash('sha256').update(data).digest('hex'), size: data.byteLength };
  }
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function imageLine(data: unknown, extra: Record<string, unknown> = {}): string {
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

async function sessionWith(lines: readonly string[]): Promise<{ dir: string; session: ReturnType<typeof openV2Session> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'v2-image-ref-'));
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  return { dir, session: openV2Session(dir) };
}

/** The counter invariant that must hold after every import. */
function expectBalanced(stats: ImportStats): void {
  expect(stats.imageBlocks).toBe(stats.imagesMigrated + stats.imagesInline);
}

describe('image_ref invariants of the v2 import', () => {
  it('replaces the inline block with a canonical image_ref and balances the counters', async () => {
    const store = new RecordingStore();
    const hook = createCasImageHook(store);
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, { onImage: hook });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(1);
    expect(stats.imagesInline).toBe(0);
    expectBalanced(stats);

    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!['type']).toBe('image_ref');
    expect(blocks[0]!['data']).toBeUndefined();
    const blob = blocks[0]!['blob'] as string;
    expect(parseCasSpillRef(blob)).not.toBeNull();
    expect(store.calls).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the block inline when the hook declines', async () => {
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, { onImage: async () => undefined });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(0);
    expect(stats.imagesInline).toBe(1);
    expectBalanced(stats);
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['type']).toBe('image');
    expect(blocks[0]!['data']).toBe(HELLO_B64);
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the block inline and reports the issue when the hook returns a foreign descriptor', async () => {
    const issues: CasImportIssue[] = [];
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, {
      onImage: async () => 'not-a-cas-reference',
      onIssue: (issue) => issues.push(issue),
    });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(0);
    expect(stats.imagesInline).toBe(1);
    expectBalanced(stats);
    expect(issues.map((issue) => issue.kind)).toEqual(['invalid-blob-ref']);
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['type']).toBe('image');
    await rm(dir, { recursive: true, force: true });
  });

  it('accounts every image block of a mixed envelope exactly once', async () => {
    const store = new RecordingStore();
    const issues: CasImportIssue[] = [];
    const hook = createCasImageHook(store, (issue) => issues.push(issue));
    const line = envelopeLine({
      message_id: 'msg-mixed',
      turn_id: 'turn-1',
      message: {
        role: 'user',
        content: [
          { type: 'image', data: HELLO_B64 },
          { type: 'text', text: 'between the images' },
          { type: 'image', data: 'not!base64!' },
        ],
      },
    });
    const { dir, session } = await sessionWith([line]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, { onImage: hook });

    expect(stats.imageBlocks).toBe(2);
    expect(stats.imagesMigrated).toBe(1);
    expect(stats.imagesInline).toBe(1);
    expectBalanced(stats);
    expect(issues.map((issue) => issue.kind)).toEqual(['invalid-base64']);
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['type']).toBe('image_ref');
    expect(blocks[1]!['type']).toBe('text');
    expect(blocks[2]!['type']).toBe('image');
    await rm(dir, { recursive: true, force: true });
  });

  it('counts no image block for a block whose data is not a string', async () => {
    const store = new RecordingStore();
    const hook = createCasImageHook(store);
    const { dir, session } = await sessionWith([imageLine(42)]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, { onImage: hook });

    expect(stats.imageBlocks).toBe(0);
    expect(stats.imagesMigrated).toBe(0);
    expect(stats.imagesInline).toBe(0);
    expectBalanced(stats);
    expect(store.calls).toHaveLength(0);
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['type']).toBe('image');
    expect(blocks[0]!['data']).toBe(42);
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps images inline when no hook is configured', async () => {
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, { cas: null });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(0);
    expect(stats.imagesInline).toBe(1);
    expectBalanced(stats);
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['type']).toBe('image');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('the hook and the CAS agree on the reference', () => {
  it('produces a reference whose digest and size describe the stored bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'v2-image-ref-cas-'));
    const store = await openCas(root);
    const hook = createCasImageHook(store);

    const reference = await hook(HELLO_B64);
    expect(reference).toBeDefined();

    const parsed = parseCasSpillRef(reference!);
    expect(parsed).not.toBeNull();
    // The size in the reference is the DECODED byte count, not the base64 length.
    expect(parsed!.size).toBe(HELLO_BYTES.byteLength);
    expect(parsed!.size).not.toBe(HELLO_B64.length);
    // The digest in the reference resolves to exactly the original bytes.
    expect(await store.get(parsed!.sha256)).toEqual(HELLO_BYTES);
    await rm(root, { recursive: true, force: true });
  });

  it('reuses one reference for a repeated payload', async () => {
    const store = new RecordingStore();
    const hook = createCasImageHook(store);
    const line = envelopeLine({
      message_id: 'msg-repeated',
      turn_id: 'turn-1',
      message: {
        role: 'user',
        content: [
          { type: 'image', data: HELLO_B64 },
          { type: 'image', data: HELLO_B64 },
        ],
      },
    });
    const { dir, session } = await sessionWith([line]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, { onImage: hook });

    expect(stats.imageBlocks).toBe(2);
    expect(stats.imagesMigrated).toBe(2);
    expectBalanced(stats);
    // The payload was stored once: the hook memoizes the reference.
    expect(store.calls).toHaveLength(1);
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['blob']).toBe(blocks[1]!['blob']);
    await rm(dir, { recursive: true, force: true });
  });

  it('bounds the reference cache instead of growing it without limit', async () => {
    const store = new RecordingStore();
    const hook = createCasImageHook(store);
    const payloads = Array.from({ length: 130 }, (_unused, index) =>
      Buffer.from(`payload-${index}`, 'utf8').toString('base64'),
    );

    const first = await hook(payloads[0]!);
    for (const payload of payloads) await hook(payload);
    expect(store.calls).toHaveLength(130);

    // The oldest entry was evicted, so the payload is stored again — and the
    // content-addressed store returns the very same reference.
    const again = await hook(payloads[0]!);
    expect(store.calls.length).toBeGreaterThanOrEqual(130);
    expect(store.calls.length).toBeLessThanOrEqual(131);
    expect(again).toBe(first);
  });
});

describe('the hook failure policy', () => {
  it('reports a non-canonical base64 payload and keeps the block inline', async () => {
    const store = new RecordingStore();
    const issues: CasImportIssue[] = [];
    const hook = createCasImageHook(store, (issue) => issues.push(issue));

    expect(await hook('not!base64!')).toBeUndefined();
    expect(issues.map((issue) => issue.kind)).toEqual(['invalid-base64']);
    // The rejected payload never reaches the store.
    expect(store.calls).toHaveLength(0);
  });

  it('fails the import loudly on a fatal store error', async () => {
    const store = new RecordingStore(() => errno('ENOSPC'));
    const hook = createCasImageHook(store);
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();

    const error = (await session.importTo(target, { onImage: hook }).then(
      () => null,
      (caught: unknown) => caught,
    )) as CasSpillError;

    expect(error).toBeInstanceOf(CasSpillError);
    expect(error.code).toBe('ENOSPC');
    // The blob was never kept inline: the import failed instead.
    expect(envelopes).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('degrades to inline on a non-fatal store error and reports it', async () => {
    const store = new RecordingStore(() => errno('EAGAIN'));
    const issues: CasImportIssue[] = [];
    const hook = createCasImageHook(store, (issue) => issues.push(issue));
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();

    const stats = await session.importTo(target, { onImage: hook });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(0);
    expect(stats.imagesInline).toBe(1);
    expectBalanced(stats);
    expect(issues.map((issue) => issue.kind)).toEqual(['store-error']);
    expect(issues[0]!.code).toBe('EAGAIN');
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['type']).toBe('image');
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps images inline when the CAS cannot be opened and the policy allows it', async () => {
    const blocker = path.join(await mkdtemp(path.join(tmpdir(), 'v2-image-ref-broken-')), 'blocker');
    await writeFile(blocker, 'not a directory');
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();
    const issues: CasImportIssue[] = [];

    const stats = await session.importTo(target, {
      cas: path.join(blocker, 'cas-root'),
      casUnavailable: 'keep-inline',
      onIssue: (issue) => issues.push(issue),
    });

    expect(stats.imageBlocks).toBe(1);
    expect(stats.imagesMigrated).toBe(0);
    expect(stats.imagesInline).toBe(1);
    expectBalanced(stats);
    expect(issues.map((issue) => issue.kind)).toEqual(['cas-unavailable']);
    const blocks = envelopes[0]!.message.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]!['type']).toBe('image');
    await rm(dir, { recursive: true, force: true });
  });

  it('fails the import when the CAS cannot be opened and no policy allows degrading', async () => {
    const blocker = path.join(await mkdtemp(path.join(tmpdir(), 'v2-image-ref-broken-')), 'blocker');
    await writeFile(blocker, 'not a directory');
    const { dir, session } = await sessionWith([imageLine(HELLO_B64)]);
    const { target, envelopes } = collectingTarget();

    const error = (await session
      .importTo(target, { cas: path.join(blocker, 'cas-root') })
      .then(
        () => null,
        (caught: unknown) => caught,
      )) as CasSpillError;

    expect(error).toBeInstanceOf(CasSpillError);
    expect(envelopes).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('canonical base64 acceptance', () => {
  it('accepts canonical payloads only', () => {
    expect(isValidBase64('aGVsbG8=')).toBe(true);
    expect(isValidBase64('AAAA')).toBe(true);
    expect(isValidBase64('AA==')).toBe(true);
    expect(isValidBase64('AAA=')).toBe(true);
  });

  it('rejects payloads a lenient decoder would silently distort', () => {
    const rejected = [
      '',
      'not!base64!',
      'aGVsbG8', // unpadded
      'aGVsbG8===', // over-padded
      'aGVs bG8=', // whitespace
      'aGVsbG8=\n', // newline
      'aGVsbG8==', // wrong tail
      'a',
      'aGVsbG9', // dangling character
    ];
    for (const value of rejected) {
      expect(isValidBase64(value), value).toBe(false);
    }
  });
});
