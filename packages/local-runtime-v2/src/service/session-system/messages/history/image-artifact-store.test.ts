/**
 * Wave-2 item 2.1/2.2 (canon 05 §2.5): the content-addressed image artifact
 * store and the receipt-boundary offload transform.
 *
 * Acceptance: one and the same image, received three times (the original
 * attach, a repeat, and the model's `read(path)` result), produces ONE file
 * under `<dataDir>/artifacts/<sha256>.<ext>` — the content address IS the
 * name — and the transform's output (what the log would store) carries the
 * artifact reference, never base64. The read pre-flight guards (device +
 * binary, `packages/agent-tools/src/shared/read-guards.ts`) ALLOW the
 * artifact file — the model's read-again path is open.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  checkBlockedDeviceRead,
  checkNonRegularFileRead,
  detectBinaryRead,
} from '../../../../../../agent-tools/src/shared/read-guards.js';
import { imageArtifactPlaceholder } from '@mavis/context-compaction';
import {
  ImageArtifactStore,
  imageArtifactExtension,
  resolveArtifactsDir,
} from './image-artifact-store.js';
import {
  imageReferencesOfEnvelope,
  offloadMessageImages,
  readImageArtifactReference,
} from './image-offload.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8AARIQBEwMDCwEAOpMBAbvpB8sAAAAASUVORK5CYII=';

const dir = mkdtempSync(join(tmpdir(), 'artifact-store-'));
const store = new ImageArtifactStore({ artifactsDir: resolveArtifactsDir(dir) });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ImageArtifactStore (2.1: the content-addressed artifact store)', () => {
  it('one image received three times → ONE file; the hash is the name; bytes stored once', () => {
    const first = store.store({ data: PNG_BASE64, mimeType: 'image/png' });
    const second = store.store({ data: PNG_BASE64, mimeType: 'image/png' });
    const third = store.store({ data: PNG_BASE64, mimeType: 'image/png' });

    expect(second.sha256).toBe(first.sha256);
    expect(third.sha256).toBe(first.sha256);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    // Dedup is physical: exactly one file for the content.
    const files = readdirSync(resolveArtifactsDir(dir)).filter((name) => name.startsWith(first.sha256));
    expect(files).toEqual([first.fileName]);
    expect(existsSync(first.path)).toBe(true);
    expect(statSync(first.path).isFile()).toBe(true);
    expect(first.path).toBe(join(resolveArtifactsDir(dir), first.fileName));
  });

  it('the reference round-trips: readData returns the exact bytes back', () => {
    const artifact = store.store({ data: PNG_BASE64, mimeType: 'image/png' });
    expect(store.readData(artifact.sha256)).toBe(PNG_BASE64);
    expect(store.readData('f'.repeat(64))).toBeUndefined();
  });

  it('distinct images get distinct files; the extension follows the mime type', () => {
    const jpeg = store.store({ data: `${PNG_BASE64}jpeg-variant`, mimeType: 'image/jpeg' });
    const png = store.store({ data: PNG_BASE64, mimeType: 'image/png' });
    expect(jpeg.sha256).not.toBe(png.sha256);
    expect(jpeg.fileName).toBe(`${jpeg.sha256}.jpeg`);
    expect(existsSync(jpeg.path)).toBe(true);
    expect(imageArtifactExtension('image/png')).toBe('.png');
    expect(imageArtifactExtension('image/webp')).toBe('.webp');
    expect(imageArtifactExtension('not-a-mime')).toBe('.bin');
  });
});

describe('offloadMessageImages (2.1: the receipt boundary — the log gets the reference, not base64)', () => {
  const artifact = store.store({ data: PNG_BASE64, mimeType: 'image/png' });

  it('replaces inline image blocks with reference blocks and records the positions', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
        ],
        timestamp: 1,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'got it' }], timestamp: 2 },
    ];
    const result = offloadMessageImages(messages, store);

    // The stored form: no base64 anywhere.
    expect(JSON.stringify(result.messages)).not.toContain(PNG_BASE64);
    const reference = readImageArtifactReference(
      (result.messages[0] as { content: { type: string }[] })['content'][1],
    );
    expect(reference).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      sha256: artifact.sha256,
      artifact: artifact.path,
    });
    // The offload record names the position (the future offload event's
    // seq/blockIdx/contentBlockIdx input).
    expect(result.offloads).toEqual([
      {
        messageIndex: 0,
        contentBlockIdx: 1,
        artifact: expect.objectContaining({ sha256: artifact.sha256 }),
      },
    ]);
    // References collected from the would-be envelope agree.
    expect(
      imageReferencesOfEnvelope({
        message_id: 'm1',
        turn_id: 't1',
        message: result.messages[0],
      }),
    ).toHaveLength(1);
  });

  it('is a no-op for already-offloaded blocks and for plain text', () => {
    const reference = {
      type: 'image',
      mimeType: 'image/png',
      sha256: artifact.sha256,
      artifact: artifact.path,
      bytes: artifact.bytes,
    };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'plain' }], timestamp: 1 },
      { role: 'user', content: [{ type: 'text', text: 'with ref' }, reference], timestamp: 2 },
    ];
    const result = offloadMessageImages(messages, store);
    expect(result.offloads).toHaveLength(0);
    expect(result.messages).toBe(messages);
  });

  it('the re-read of the same image (a read(path) result) offloads to the SAME sha — not a copy', () => {
    // The model called read(artifact.path); the read tool returns the image
    // inline again — the same base64 the artifact was created from.
    const reRead = [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [
          { type: 'text', text: 'image content' },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
        ],
        isError: false,
        timestamp: 3,
      },
    ];
    const result = offloadMessageImages(reRead, store);
    expect(result.offloads).toHaveLength(1);
    expect(result.offloads[0]!.artifact.sha256).toBe(artifact.sha256);
    // The physical store holds one copy: the dedup hit created nothing.
    const files = readdirSync(resolveArtifactsDir(dir));
    expect(files.filter((name) => name.endsWith('.png'))).toHaveLength(1);
  });
});

describe('the read-again stub and the read guards (2.2)', () => {
  it('the stub names the path, the mime type and the size (pi codemode shape)', () => {
    const mb = 1_048_576;
    expect(imageArtifactPlaceholder({ artifact: '/data/artifacts/ab12.png', mimeType: 'image/png', bytes: mb })).toBe(
      '[Image saved to /data/artifacts/ab12.png (image/png, 1.0 MB) — use read to view again]',
    );
    expect(imageArtifactPlaceholder({ artifact: '/a.png', mimeType: 'image/jpeg', bytes: 640 * 1_024 })).toBe(
      '[Image saved to /a.png (image/jpeg, 640 KB) — use read to view again]',
    );
  });

  it('the read guards ALLOW the artifact file (the model read-again path is open)', async () => {
    const artifact = store.store({ data: PNG_BASE64, mimeType: 'image/png' });
    // Device guard: a regular file passes.
    expect(checkBlockedDeviceRead(artifact.path)).toBeNull();
    // FIFO/socket/block-device guard: a regular file passes.
    expect(await checkNonRegularFileRead(artifact.path)).toBeNull();
    // Binary guard: a .png artifact is a pi-supported image — allowed, so the
    // read tool renders it inline (the model sees the image again).
    const verdict = await detectBinaryRead(artifact.path);
    expect(verdict).toEqual({ binary: false });
  });
});
