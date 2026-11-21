/**
 * V-C09 closure, cross-package leg: the FULL frozen SystemMessage checkpoint
 * written by `compact()` reads back through EVERY consumer of the checkpoint
 * — this package's own projection/estimator/usage-tracker, the canonical
 * `@mavis/context-projection` fold (whose `CompactionMark` now carries the
 * frozen system), and the `convert-to-llm` transcript seed — while legacy
 * `string|null` logs keep reading unchanged (the deferral's acceptance
 * conditions 1–3, port-pi-1.3/state/w03.md "Deferred to W05").
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
  compact,
  createFrozenSystemMessage,
  isFrozenSystemMessage,
  normalizeCheckpointSystemMessage,
  parseCompactionEntry,
  projectContext,
  renderFrozenSystemText,
  windowManifestBytes,
  WindowUsageTracker,
  estimateProjectedContextTokens,
  type CompactionEntryPayload,
  type LogEntry,
} from '../../src/index.js';
import { ProjectionService, asCompactionPayload, buildProjection } from '../../../context-projection/src/index.js';
import type { Entry, JsonValue, Seq } from '../../../durable-backend-sqlite-zstd/src/types.js';
import { transcriptStateFromCheckpoint } from '../../../convert-to-llm/src/index.js';
import { RecordingSummarizer, filler, messageEntry, stamp, userMessage } from './helpers.js';

const FROZEN = createFrozenSystemMessage('base prompt', {
  sections: { env: 'prod' },
  toolsAdded: [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
  timestamp: 4711,
});

function bigLog(): LogEntry[] {
  return [
    messageEntry(userMessage('start')),
    ...Array.from({ length: 8 }, (_, i) => messageEntry(userMessage(`${filler(4000)}-${i}`))),
  ];
}

describe('frozen-system helpers', () => {
  it('renders content + non-null sections, pin getSystemMessageText semantics', () => {
    expect(renderFrozenSystemText(FROZEN)).toBe('base prompt\n\nprod');
    expect(renderFrozenSystemText(createFrozenSystemMessage('', { timestamp: 1 }))).toBe('');
  });

  it('normalize maps every spelling to (text, frozen)', () => {
    expect(normalizeCheckpointSystemMessage(null)).toEqual({ text: null, frozen: null });
    expect(normalizeCheckpointSystemMessage('legacy')).toEqual({ text: 'legacy', frozen: null });
    expect(normalizeCheckpointSystemMessage(FROZEN)).toEqual({ text: 'base prompt\n\nprod', frozen: FROZEN });
  });

  it('isFrozenSystemMessage guards the JSON shape', () => {
    expect(isFrozenSystemMessage(FROZEN)).toBe(true);
    expect(isFrozenSystemMessage({ role: 'user', content: 'x', timestamp: 1 })).toBe(false);
    expect(isFrozenSystemMessage({ role: 'system', content: 7, timestamp: 1 })).toBe(false);
    expect(isFrozenSystemMessage({ role: 'system', content: 'x', timestamp: 1, toolsAdded: [{ nome: 'x' }] })).toBe(false);
  });
});

describe('compact() writes the full frozen form (V-C09 writer)', () => {
  it('records the complete system message and renders it for the estimate', async () => {
    const outcome = await compact({
      entries: bigLog(),
      summarizer: new RecordingSummarizer('S').call,
      keepRecentTokens: 100,
      frozenSystemMessage: FROZEN,
    });
    expect(outcome).not.toBeNull();
    const payload = outcome!.draft.payload as CompactionEntryPayload;
    expect(payload.systemMessage).toEqual(FROZEN);
    // estimatedTokensAfter charged the RENDERED prompt (content + sections).
    const renderedChars = 'base prompt\n\nprod'.length;
    expect(outcome!.estimatedTokensAfter).toBeGreaterThanOrEqual(Math.ceil(renderedChars / 4));
  });

  it('frozenSystemMessage wins over the legacy string option', async () => {
    const outcome = await compact({
      entries: bigLog(),
      summarizer: new RecordingSummarizer('S').call,
      keepRecentTokens: 100,
      frozenSystemMessage: FROZEN,
      systemMessage: 'legacy text',
    });
    expect((outcome!.draft.payload as CompactionEntryPayload).systemMessage).toEqual(FROZEN);
  });

  it('the legacy string path is unchanged', async () => {
    const outcome = await compact({
      entries: bigLog(),
      summarizer: new RecordingSummarizer('S').call,
      keepRecentTokens: 100,
      systemMessage: 'legacy text',
    });
    expect((outcome!.draft.payload as CompactionEntryPayload).systemMessage).toBe('legacy text');
  });
});

describe('every checkpoint reader accepts the full form', () => {
  function checkpointLog(systemMessage: CompactionEntryPayload['systemMessage']): LogEntry[] {
    const log = bigLog();
    const base = compactSyncOver(log);
    const checkpoint = stamp({
      id: 'cp',
      kind: 'mcode.compaction',
      payload: { ...base, systemMessage },
    });
    return [...log, checkpoint];
  }

  /** The deterministic part of compact() without a summarizer round-trip. */
  function compactSyncOver(log: LogEntry[]): CompactionEntryPayload {
    return {
      summary: 'S',
      firstKeptEntryId: log[log.length - 1]!.id,
      systemMessage: null,
      isSplitTurn: false,
      tokensBefore: 0,
      estimatedTokensAfter: 0,
      createdAtMs: 0,
    };
  }

  it('parseCompactionEntry keeps the full-form checkpoint well-formed', () => {
    const entries = checkpointLog(FROZEN);
    const checkpoint = entries[entries.length - 1]!;
    expect(parseCompactionEntry(checkpoint)?.systemMessage).toEqual(FROZEN);
    // A corrupt object shape stays malformed (audit noise), like before.
    const corrupt = checkpointLog({ role: 'system', content: 7, timestamp: 1 } as never);
    expect(parseCompactionEntry(corrupt[corrupt.length - 1]!)).toBeUndefined();
  });

  it('projectContext renders the full form into the prompt-text view', () => {
    const projected = projectContext(checkpointLog(FROZEN));
    expect(projected.systemMessage).toBe('base prompt\n\nprod');
  });

  it('the usage tracker and the slow reference stay equal (token + byte axes)', () => {
    const entries = checkpointLog(FROZEN);
    const tracker = new WindowUsageTracker();
    tracker.ingest(entries);
    expect(tracker.usage().tokens).toBe(estimateProjectedContextTokens(entries).tokens);
    expect(tracker.usage().bytes).toBe(windowManifestBytes(entries));
  });

  it('the canonical context-projection fold accepts the checkpoint and its mark carries the frozen system', () => {
    const entries = checkpointLog(FROZEN);
    const projectionEntries: Entry[] = entries.map((entry, index) => ({
      id: entry.id,
      parentId: null,
      kind: entry.kind === 'mcode.message' ? 'pi.user' : entry.kind,
      payload: entry.payload as JsonValue,
      seq: (index + 1) as Seq,
      ordinal: 0,
    }));
    const manifest = buildProjection(projectionEntries);
    expect(manifest.compaction?.systemMessage).toMatchObject({ role: 'system', content: 'base prompt' });
    // asCompactionPayload accepts the full form...
    expect(
      asCompactionPayload(entries[entries.length - 1]!.payload, 'cp').systemMessage,
    ).toMatchObject({ content: 'base prompt' });
    // ...and the ProjectionService applies the same cut without error.
    const service = new ProjectionService();
    for (let index = 0; index < projectionEntries.length; index += 1) {
      const commit = {
        seq: (index + 1) as Seq,
        batchId: index + 1 as never,
        entryCount: 1,
        head: (index + 1) as Seq,
        codec: 'zstd' as const,
        compressedBytes: 0,
        uncompressedBytes: 0,
        entries: [projectionEntries[index]!],
      };
      service.apply(commit);
    }
    expect(service.manifest().compaction?.firstKeptEntryId).toBe(entries[entries.length - 2]!.id);
    expect(service.manifest()).toEqual(manifest);
  });

  it('the convert-to-llm seed accepts the full form and re-baselines tools', () => {
    // Vocabulary adapter (same discipline as the checkpoint-cross-package
    // test): the frozen form crosses the package boundary as JSON; the
    // transcript layer's local declaration of the same shape receives it.
    const seeded = transcriptStateFromCheckpoint(FROZEN as never);
    expect([...seeded.tools.keys()]).toEqual(['read']);
    expect(seeded.timestamp).toBe(4711);
    expect(seeded.sections.get('env')).toBe('prod');
  });

  it('legacy string and null logs keep reading without regression', () => {
    const legacy = checkpointLog('legacy text');
    expect(projectContext(legacy).systemMessage).toBe('legacy text');
    const none = checkpointLog(null);
    expect(projectContext(none).systemMessage).toBeNull();
    const tracker = new WindowUsageTracker();
    tracker.ingest(legacy);
    expect(tracker.usage().tokens).toBe(estimateProjectedContextTokens(legacy).tokens);
  });
});
