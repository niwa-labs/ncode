/**
 * Wave-2 item 2.5 (canon 05 §2.5): the summarizer receives the offloaded
 * images as read-again stubs naming the artifact path — the summary can
 * reference the path, and base64 never reaches the summarizer.
 *
 * The serialization half pins `serializeConversation` (user and toolResult
 * reference blocks; inline image blocks unchanged); the pipeline half runs
 * the REAL `compact` over a window with an offloaded screenshot and pins the
 * captured prompt.
 */

import { describe, expect, it } from 'vitest';

import { compact, imageArtifactPlaceholder, serializeConversation } from '../../src/index.js';
import type { CompactionMessage, LogEntry } from '../../src/index.js';
import { RecordingSummarizer, filler, messageEntry } from './helpers.js';

const ARTIFACT = '/data/minimax/artifacts/ab12cd34.png';

function offloadedImageBlock(bytes = 1_048_576) {
  return { type: 'image', mimeType: 'image/png', sha256: 'ab12cd34', artifact: ARTIFACT, bytes };
}

function userWithOffloadedImage(text: string): CompactionMessage {
  return { role: 'user', content: [{ type: 'text', text }, offloadedImageBlock()] };
}

function toolResultWithOffloadedImage(text: string): CompactionMessage {
  return {
    role: 'toolResult',
    content: [{ type: 'text', text }, offloadedImageBlock()],
    toolCallId: 'call-1',
  };
}

describe('serializeConversation: offloaded images become read-again stubs', () => {
  it('the toolResult stub names the artifact path, mime type and size', () => {
    const text = serializeConversation([toolResultWithOffloadedImage('screenshot taken')]);
    expect(text).toContain('[Tool result image]:');
    expect(text).toContain(ARTIFACT);
    expect(text).toContain('(image/png, 1.0 MB)');
    expect(text).toContain('use read to view again');
  });

  it('the user stub names the artifact path too', () => {
    const text = serializeConversation([userWithOffloadedImage('посмотри на скриншот')]);
    expect(text).toContain('[User image]:');
    expect(text).toContain(ARTIFACT);
  });

  it('inline image blocks (no artifact reference) render nothing — the baseline is unchanged', () => {
    const inline: CompactionMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'inline shot' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    };
    expect(serializeConversation([inline])).toBe('[User]: inline shot');
  });

  it('the placeholder format matches the pi codemode shape exactly', () => {
    expect(imageArtifactPlaceholder({ artifact: '/a/b.png', mimeType: 'image/png', bytes: 1_048_576 })).toBe(
      '[Image saved to /a/b.png (image/png, 1.0 MB) — use read to view again]',
    );
  });
});

describe('the compaction pipeline feeds the stubs to the summarizer (2.5 acceptance)', () => {
  it('the captured prompt carries the artifact path; the summary can reference it', async () => {
    // A window with one offloaded screenshot; heavy filler behind it so the
    // cut summarizes the screenshot's turn.
    const entries: LogEntry[] = [
      messageEntry(userWithOffloadedImage('screenshot of the bug')),
      messageEntry({
        role: 'assistant',
        content: [{ type: 'text', text: 'I can see the broken layout.' }],
      }),
      messageEntry({ role: 'user', content: `more context ${filler(240_000)}` }),
    ];
    const summarizer = new RecordingSummarizer('## Goal\nFix the layout. Screenshot: [Image saved to /data/minimax/artifacts/ab12cd34.png]');
    const outcome = await compact({ entries, summarizer: summarizer.call });

    expect(outcome).not.toBeNull();
    // THE acceptance: the summarizer's prompt contains the artifact PATH —
    // the summary CAN reference it.
    expect(summarizer.prompts).toHaveLength(1);
    expect(summarizer.prompts[0]).toContain(ARTIFACT);
    expect(summarizer.prompts[0]).toContain('use read to view again');
    // ...and no base64 reached the summarizer (offloaded = reference only;
    // the prompt has no inline image data at all).
    expect(summarizer.prompts[0]).not.toContain('data:image');
  });
});
