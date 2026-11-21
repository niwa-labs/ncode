import { readImageEncodedContent } from '@mavis/agent-core/tools';
import { describe, expect, it, vi } from 'vitest';

// OUR vendor 1.5.2 has no ImageProcessorUnavailableError: it falls back to
// in-process resizing internally, so a resizeImage throw means the image
// processing runtime itself cannot load — the request-media pipeline maps
// every throw to the processor-unavailable outcome.
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...actual,
    resizeImage: vi.fn(() => Promise.reject(new Error('photon worker cannot be loaded'))),
  };
});

const { encodeRequestImage, encodeRequestImageBlocks } = await import('../src/index.js');

describe('image processor unavailable', () => {
  it('replaces a tool result image over the limits with the Read tool note', async () => {
    const blocks = [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ];

    const output = await encodeRequestImageBlocks(blocks);
    expect(output).toEqual([
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'text', text: '[Image omitted: image processing runtime is unavailable.]' },
    ]);
    expect(readImageEncodedContent(output, JSON.stringify(blocks))).toEqual([
      { mimeType: 'image/png', omittedReason: 'processor_unavailable' },
    ]);
  });

  it('keeps the original for callers that encode a single image', async () => {
    await expect(
      encodeRequestImage(Buffer.from('AAAA', 'base64'), 'image/png'),
    ).resolves.toBeUndefined();
  });
});
