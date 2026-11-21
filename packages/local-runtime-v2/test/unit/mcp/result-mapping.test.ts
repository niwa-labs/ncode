/**
 * W08 review round 1 — structuredContent JSON-value regression pin.
 *
 * pi-mcp types `CallToolResult.structuredContent` as `unknown` (MCP
 * 2026-07-28 allows any JSON value; vendored
 * `third_party/pi-mono/packages/mcp/src/protocol/content.ts:68`). The mapping
 * layer must not narrow it to plain objects through `readRecord`, or
 * array/scalar structured content silently loses both the preserved field and
 * its model-facing text fallback.
 */
import { describe, expect, it } from 'vitest';

import {
  mapMcpContent,
  normalizeCallResult,
} from '../../../src/service/mcp/tools/result-mapping.js';
import type { LocalMcpCallResult } from '../../../src/service/mcp/contracts.js';

describe('normalizeCallResult structuredContent', () => {
  it('keeps object structured content (legacy behavior)', () => {
    const result = normalizeCallResult({
      content: [],
      structuredContent: { answer: 42 },
    });
    expect(result.structuredContent).toEqual({ answer: 42 });
  });

  it('keeps array structured content (MCP 2026-07-28 any-JSON-value)', () => {
    const result = normalizeCallResult({
      content: [],
      structuredContent: [{ id: 'a' }, { id: 'b' }],
    });
    expect(result.structuredContent).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('keeps scalar structured content', () => {
    const result = normalizeCallResult({ content: [], structuredContent: 'plain-string' });
    expect(result.structuredContent).toBe('plain-string');
  });

  it('omits the field when the server sent none', () => {
    const result = normalizeCallResult({ content: [{ type: 'text', text: 'hi' }] });
    expect('structuredContent' in result).toBe(false);
  });
});

describe('mapMcpContent structured text fallback', () => {
  it('emits the JSON text fallback for array structured content', () => {
    const mapped = mapMcpContent({
      content: [],
      structuredContent: [1, 2, 3],
    } as LocalMcpCallResult);
    expect(mapped.content).toEqual([{ type: 'text', text: '[MCP structured content]\n[1,2,3]' }]);
    expect(mapped.text).toContain('[1,2,3]');
  });

  it('emits the JSON text fallback for scalar structured content', () => {
    const mapped = mapMcpContent({
      content: [],
      structuredContent: 'plain-string',
    } as LocalMcpCallResult);
    expect(mapped.content).toEqual([
      { type: 'text', text: '[MCP structured content]\n"plain-string"' },
    ]);
  });

  it('keeps the object fallback unchanged', () => {
    const mapped = mapMcpContent({
      content: [],
      structuredContent: { answer: 42 },
    } as LocalMcpCallResult);
    expect(mapped.content).toEqual([{ type: 'text', text: '[MCP structured content]\n{"answer":42}' }]);
  });

  it('adds no fallback when structured content is absent', () => {
    const mapped = mapMcpContent({
      content: [{ type: 'text', text: 'only text' }],
    } as LocalMcpCallResult);
    expect(mapped.content).toEqual([{ type: 'text', text: 'only text' }]);
    expect(mapped.text).toBe('only text');
  });
});
