/**
 * Wave-0 item 0.5 (canon 05 §2.5): structured RESIDENT image rendering on
 * the per-entry conversion stage.
 *
 * The dialect's baseline (every image → the `[image: <mime>]` placeholder)
 * is unchanged — the all-placeholder bytes are the equivalence gates' pin.
 * When a residency overlay renders a page as a STRUCTURED block
 * (`ImageRendering.renderImageBlock`), the record text marks the block's
 * position (`imageBlockMarker`), the record carries the base64 on `images`,
 * and the NDJSON wire body (`serializeCompiledEntry`) stays the marker text —
 * the wire-compiler mapping hands the blocks to the runtime's record port.
 */

import { describe, expect, it } from 'vitest';

import { compiledEntryToWireEntry } from '../../../wire-compiler/src/index.js';
import {
  MINIMAX_M3_DIALECT,
  convertEntry,
  imageBlockMarker,
  recordCacheKey,
  serializeCompiledEntry,
  splitImageBlockMarkers,
  type ImageRendering,
} from '../../src/index.js';
import { makeEntry, userEntry } from './helpers.js';

const SCREENSHOT: ImageRendering = {
  cacheState: 'resident@abc123',
  renderImageBlock: (part) =>
    part.data === undefined ? undefined : { data: part.data, mimeType: part.mimeType },
};

describe('image-block rendering (convertEntry)', () => {
  it('renders a resident image as a marker in the text and a structured block on the record', () => {
    // A pi.user message with mixed content blocks: image first, text after.
    const mixed = makeEntry('u2', 'pi.user', {
      model: [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'text', text: 'вот скриншот' },
          ],
          timestamp: 1,
        },
      ],
    });
    const record = convertEntry(mixed, undefined, SCREENSHOT)!;
    expect(record.images).toEqual([{ data: 'aW1hZ2U=', mimeType: 'image/png' }]);
    // The marker stands at the image's exact position (before the caption).
    expect(splitImageBlockMarkers(record.content)).toEqual({
      segments: ['', '\n\nвот скриншот'],
      imageIndexes: [0],
    });
    expect(imageBlockMarker(0)).toBe('\u0000mcode-image:0\u0000');
  });

  it('keeps the placeholder bytes when no rendering override is given', () => {
    const mixed = makeEntry('u2', 'pi.user', {
      model: [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'text', text: 'вот скриншот' },
          ],
          timestamp: 1,
        },
      ],
    });
    const baseline = convertEntry(mixed)!;
    expect(baseline.images).toBeUndefined();
    expect(baseline.content).toBe('[image: image/png]\n\nвот скриншот');
  });

  it('renders a resident toolResult image (the screenshot path)', () => {
    const entry = makeEntry('t1', 'pi.tool-result', {
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'screen',
          content: [
            { type: 'text', text: 'captured' },
            { type: 'image', data: 'c2hvdA==', mimeType: 'image/jpeg' },
          ],
          isError: false,
          timestamp: 3,
        },
      ],
    });
    const record = convertEntry(entry, undefined, SCREENSHOT)!;
    expect(record.role).toBe('tool');
    expect(record.images).toEqual([{ data: 'c2hvdA==', mimeType: 'image/jpeg' }]);
    expect(record.content).toContain(imageBlockMarker(0));
  });

  it('does not mutate the wire body: serializeCompiledEntry carries the marker text only', () => {
    const mixed = makeEntry('u2', 'pi.user', {
      model: [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'text', text: 'вот скриншот' },
          ],
          timestamp: 1,
        },
      ],
    });
    const rendered = convertEntry(mixed, undefined, SCREENSHOT)!;
    const body = JSON.parse(serializeCompiledEntry(rendered)) as { content: string };
    expect(body.content).toBe(rendered.content);
    expect(body.content).not.toContain('aW1hZ2U='); // base64 never enters the NDJSON body
  });

  it('folds the cache state into the record cache key (the two renderings never share bytes)', () => {
    const entry = userEntry('u1', 'text only');
    expect(recordCacheKey(entry.id, MINIMAX_M3_DIALECT, SCREENSHOT)).not.toBe(
      recordCacheKey(entry.id, MINIMAX_M3_DIALECT, undefined),
    );
  });

  it('a digest page (renderImageBlock returns undefined) keeps the placeholder', () => {
    const digest: ImageRendering = {
      cacheState: 'digest',
      renderImageBlock: () => undefined,
    };
    const mixed = makeEntry('u2', 'pi.user', {
      model: [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'text', text: 'вот скриншот' },
          ],
          timestamp: 1,
        },
      ],
    });
    const record = convertEntry(mixed, undefined, digest)!;
    expect(record.images).toBeUndefined();
    expect(record.content).toBe('[image: image/png]\n\nвот скриншот');
  });
});

describe('wire-compiler mapping (compiledEntryToWireEntry)', () => {
  it('hands the record images to the mapped entry as image blocks; the dialect body stays text', () => {
    const mixed = makeEntry('u2', 'pi.user', {
      model: [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'text', text: 'вот скриншот' },
          ],
          timestamp: 1,
        },
      ],
    });
    const rendered = convertEntry(mixed, undefined, SCREENSHOT)!;
    const mapped = compiledEntryToWireEntry(rendered);
    const blocks = mapped.content as readonly { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image']);
    expect(blocks[1]).toMatchObject({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
    expect(blocks[0]!.text).toBe(rendered.content);
  });

  it('a placeholder-baseline record maps without image blocks', () => {
    const mixed = makeEntry('u2', 'pi.user', {
      model: [
        {
          role: 'user',
          content: [
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'text', text: 'вот скриншот' },
          ],
          timestamp: 1,
        },
      ],
    });
    const baseline = convertEntry(mixed)!;
    const mapped = compiledEntryToWireEntry(baseline);
    const blocks = mapped.content as readonly { type: string }[];
    expect(blocks.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('splitImageBlockMarkers', () => {
  it('splits markers with surrounding text in order', () => {
    expect(
      splitImageBlockMarkers(`a${imageBlockMarker(0)}b${imageBlockMarker(1)}c`),
    ).toEqual({ segments: ['a', 'b', 'c'], imageIndexes: [0, 1] });
  });

  it('keeps unterminated and malformed marker bytes verbatim', () => {
    expect(splitImageBlockMarkers('start\u0000mcode-image:')).toEqual({
      segments: ['start\u0000mcode-image:'],
      imageIndexes: [],
    });
    expect(splitImageBlockMarkers('\u0000mcode-image:x\u0000tail')).toEqual({
      segments: ['\u0000mcode-image:x\u0000tail'],
      imageIndexes: [],
    });
  });

  it('text without markers is one segment', () => {
    expect(splitImageBlockMarkers('plain text')).toEqual({
      segments: ['plain text'],
      imageIndexes: [],
    });
  });
});
