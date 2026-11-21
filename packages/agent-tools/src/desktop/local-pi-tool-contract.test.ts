/**
 * W04 tool-contract funnel (W07 part A): the per-tool converters between the
 * pin's `AgentToolResult` and our `ToolResult` must preserve the programmatic
 * contract fields — `structuredContent`, `usage` and `isError` — instead of
 * dropping them. `structuredContent` stays out of the model-facing content;
 * `usage` is tool-owned accounting; `isError` keeps wrapper-level failures
 * visible to the agent loop without throwing.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentToolResult } from '@earendil-works/pi-agent-core';

import { piReadResultToToolResult } from '../shared/read-result.js';
import { localBashResultFromPi } from './local-bash-result.js';
import { LocalBashTool, LocalReadTool, toToolResult } from './local-pi-tools.js';
import type { LocalRuntimeToolContext } from './types.js';

const context = { sessionId: 'tool-contract', turnId: 'tool-contract-turn' } satisfies LocalRuntimeToolContext;

const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 10,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

function piResult(overrides: Partial<AgentToolResult<Record<string, unknown>>> = {}): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text: 'body' }],
    details: {},
    ...overrides,
  };
}

describe('per-tool pi→ToolResult contract preservation', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-pi-tool-contract-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps isError/structuredContent/usage through the read tool boundary', async () => {
    const file = join(directory, 'subject.txt');
    await writeFile(file, 'hello');
    const tool = new LocalReadTool(directory);
    vi.spyOn((tool as unknown as { tool: { execute: unknown } }).tool, 'execute').mockResolvedValue(
      piResult({
        isError: true,
        structuredContent: { kind: 'text', value: 'hello' },
        usage,
      }),
    );

    const result = await tool.execute(context, { path: 'subject.txt' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ kind: 'text', value: 'hello' });
    expect(result.usage).toEqual(usage);
    // The machine-readable channel never leaks into model-facing content.
    expect(result.content.every((block) => !('structuredContent' in block))).toBe(true);
  });

  it('keeps the fields through the shared read converter without inventing them', async () => {
    const preserved = piReadResultToToolResult(
      'read',
      piResult({ isError: true, structuredContent: { v: 1 }, usage }),
    );
    expect(preserved.isError).toBe(true);
    expect(preserved.structuredContent).toEqual({ v: 1 });
    expect(preserved.usage).toEqual(usage);

    const bare = piReadResultToToolResult('read', piResult());
    expect(bare.isError).toBeUndefined();
    expect(bare.structuredContent).toBeUndefined();
    expect(bare.usage).toBeUndefined();
  });

  it('keeps the fields when the pin result carries error facts for an existing file', async () => {
    const file = join(directory, 'other.txt');
    await writeFile(file, 'content');
    const tool = new LocalReadTool(directory);
    const inner = (tool as unknown as { tool: { execute: unknown } }).tool;
    vi.spyOn(inner as { execute: unknown }, 'execute').mockResolvedValue(
      piResult({
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
        structuredContent: { error: 'boom' },
        usage,
      }),
    );
    const result = await tool.execute(context, { path: 'other.txt' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: 'boom' });
    expect(result.usage).toEqual(usage);
  });

  // W07 review round 1 (П1): write and edit route through the same
  // `toToolResult` converter — pin both directions there.
  it('keeps the fields through the shared write/edit converter without inventing them', () => {
    const preserved = toToolResult(
      'write',
      piResult({ isError: true, structuredContent: { v: 2 }, usage }),
    );
    expect(preserved.isError).toBe(true);
    expect(preserved.structuredContent).toEqual({ v: 2 });
    expect(preserved.usage).toEqual(usage);
    expect(preserved.content.every((block) => !('structuredContent' in block))).toBe(true);

    const bare = toToolResult('edit', piResult());
    expect(bare.isError).toBeUndefined();
    expect(bare.structuredContent).toBeUndefined();
    expect(bare.usage).toBeUndefined();
  });

  // W07 review round 1 (П1): the bash boundary (`localBashResultFromPi`) is
  // the converter that dropped the programmatic channel — pin it directly.
  it('keeps structuredContent/usage through the bash converter without inventing them', () => {
    const carried = localBashResultFromPi(
      piResult({
        structuredContent: { output: 'hi', truncated: false, exit_code: 0, wall_time_seconds: 0.1 },
        usage,
      }),
    );
    expect(carried.structuredContent).toEqual({
      output: 'hi',
      truncated: false,
      exit_code: 0,
      wall_time_seconds: 0.1,
    });
    expect(carried.usage).toEqual(usage);

    const bare = localBashResultFromPi(piResult({ details: { execution: { status: 'succeeded' } } }));
    expect(bare.structuredContent).toBeUndefined();
    expect(bare.usage).toBeUndefined();
    expect(bare.isError).toBeUndefined();
  });

  // W07 review round 1 (П1): end to end — the pin bash result's
  // `structuredContent.exit_code` must reach the product ToolResult.
  it('carries the pin structuredContent through the desktop bash tool', async () => {
    const tool = new LocalBashTool(directory, undefined, { mode: 'off' });
    const result = await tool.execute(context, { command: 'echo contract-ok' });
    expect(result.text).toContain('contract-ok');
    const structured = result.structuredContent as { exit_code?: number } | undefined;
    expect(structured?.exit_code).toBe(0);
    expect(result.content.every((block) => !('structuredContent' in block))).toBe(true);
  });
});
