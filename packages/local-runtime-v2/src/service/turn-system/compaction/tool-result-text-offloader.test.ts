/**
 * Wave-2 item 2.4 (canon 05 §2.2): the tool-result TEXT offload axis — the
 * legacy `tool_archive` compaction demoted to an offload pass.
 *
 * Acceptance: the plan over the canonical history materializes the artifact
 * and applies `offloadToolText` events (artifact with the full text, stub
 * receipt with the reference) — no compaction starts, no `compactContext`
 * call; below the watermark the pass is a no-op; and the WIRE-MODE hook
 * composes NO legacy compactor: `automatic: undefined` makes the hook exactly
 * the unified barrier + the offload pass, and it never touches
 * `compactBeforeLlm`.
 */

import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  createAutomaticContextCompactionHook,
  ContextCompactionAttemptFactory,
} from '../agent-host/compaction/context-compaction.js';
import { ToolResultArchiver } from './algorithm/tool-result-archiver.js';
import { createToolResultTextOffloader } from './tool-result-text-offloader.js';

const archiverConfig = {
  enabled: true,
  watermarkBytes: 1_000,
  minSavingsBytes: 500,
  minCandidateBytes: 200,
  keepRecentRounds: 1,
} as const;

function archiverWithMemory(): { archiver: ToolResultArchiver; written: { text: string; reference: string }[] } {
  const written: { text: string; reference: string }[] = [];
  const archiver = new ToolResultArchiver({
    writeArtifact: (input) => {
      const reference = `cas://sha256/${input.text.length}`;
      written.push({ text: input.text, reference });
      return { reference, metadata: { read_format: 'cas_v1' } };
    },
    getConfig: () => archiverConfig,
  });
  return { archiver, written };
}

function bigToolResult(callId: string, chars: number, timestamp: number): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'bash',
    content: [{ type: 'text', text: 'x'.repeat(chars) }],
    isError: false,
    timestamp,
  } as AgentMessage;
}

function assistantToolCall(callId: string, timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: '{}' }],
    timestamp,
  } as AgentMessage;
}

describe('createToolResultTextOffloader (the axis, no compaction)', () => {
  it('plans the archiver over the canonical history and applies the offload events', async () => {
    const { archiver, written } = archiverWithMemory();
    const applied: {
      envelopeIndex: number;
      replacement: string;
      reference: string;
    }[][] = [];
    const offload = createToolResultTextOffloader({
      archiver,
      readActiveMessages: async () => [
        // Two rounds: the recent one (call-2) stays protected
        // (keepRecentRounds: 1), the OLD big result is the candidate.
        assistantToolCall('call-1', 1),
        bigToolResult('call-1', 4_000, 2),
        assistantToolCall('call-2', 3),
        bigToolResult('call-2', 300, 4),
      ],
      offloadToolText: async (_sessionId, items) => {
        applied.push([...items]);
      },
    });

    const count = await offload('session-1');
    expect(count).toBe(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual([
      {
        envelopeIndex: 1,
        replacement: expect.stringContaining('cas://sha256/4000'),
        reference: 'cas://sha256/4000',
      },
    ]);
    // The artifact holds the FULL text (the receipt names the reference).
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toHaveLength(4_000);
  });

  it('below the watermark the pass is a no-op (no artifact, no events)', async () => {
    const { archiver, written } = archiverWithMemory();
    let applied = 0;
    const offload = createToolResultTextOffloader({
      archiver,
      readActiveMessages: async () => [
        assistantToolCall('call-1', 1),
        bigToolResult('call-1', 100, 2),
      ],
      offloadToolText: async () => {
        applied += 1;
      },
    });
    expect(await offload('session-2')).toBe(0);
    expect(written).toHaveLength(0);
    expect(applied).toBe(0);
  });

  it('without the durable seam (jsonl) the axis is a no-op', async () => {
    const { archiver } = archiverWithMemory();
    const offload = createToolResultTextOffloader({
      archiver,
      readActiveMessages: async () => [bigToolResult('call-1', 4_000, 1)],
    });
    expect(await offload('session-3')).toBe(0);
  });
});

describe('the wire-mode hook composes NO legacy compactor (2.4 acceptance)', () => {
  it('automatic: undefined — the hook is the barrier + the offload pass, never compactBeforeLlm', async () => {
    let offloadRuns = 0;
    const hook = createAutomaticContextCompactionHook(
      {
        // The wire-mode composition: no legacy compactor.
        automatic: undefined,
        lifecycle: {
          failCommittedHistory: async () => undefined,
        } as never,
        toolResultOffload: async () => {
          offloadRuns += 1;
        },
      },
      {
        sessionId: 's-hook',
        turnId: 't-hook',
        turnSequence: 1,
      } as never,
      'lease-1',
      { attempts: new ContextCompactionAttemptFactory() },
    );
    const decision = await hook({
      sessionId: 's-hook',
      phase: 'llm-call',
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }] as never,
      thinkingLevel: 'off',
    } as never);
    expect(decision).toEqual({ type: 'continue' });
    expect(offloadRuns).toBe(1);
  });
});
