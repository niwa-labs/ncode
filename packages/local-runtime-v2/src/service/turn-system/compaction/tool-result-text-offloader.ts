/**
 * Wave 2 (canon 05 §2.2, item 2.4): the tool-result TEXT offload axis — the
 * legacy `tool_archive` compaction demoted to an OFFLOAD pass.
 *
 * What changed: the legacy axis ran as an automatic COMPACTION —
 * `AutomaticContextCompactor.compactBeforeLlm` → `compactContext` → a
 * `replaceMessages` delivery whose durable commit rewrote the WHOLE history
 * (`full reason=compact`, incident 2026-11-07 batch 17268: 3.85 MB
 * re-serialized for a text-only squeeze). This module plans the SAME
 * archiver over the CURRENT canonical history and applies the result as
 * kilobyte `history.v2.offload{seq, blockIdx, replacement → artifactRef}`
 * events instead: the artifact (CAS spill / reports dir) keeps the full
 * text, the active history shows the stub receipt, and the log keeps the
 * original bytes append-only. No compaction starts, no compaction lease, no
 * summary — the byte/token window axes belong to the unified scheduler.
 *
 * Fail-safe by contract: every fault throws to the caller (the before-LLM
 * hook catches and logs; the request proceeds) — the axis is maintenance,
 * never a commit precondition.
 *
 * @module
 */

import { createLogger } from '@mavis/logging';

import type { ToolResultArchiver } from './algorithm/tool-result-archiver.js';

const log = createLogger('mcode:compaction');

/** The text blocks of one message, joined (the receipt is a single text block). */
function joinedTextBlocks(message: unknown): string | undefined {
  const content = (message as { content?: unknown })['content'];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (block): block is { readonly type: string; readonly text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown })['type'] === 'text' &&
        typeof (block as { text?: unknown })['text'] === 'string',
    )
    .map((block) => block.text)
    .join('\n');
  return text.length > 0 ? text : undefined;
}

export interface ToolResultTextOffloaderOptions {
  readonly archiver: ToolResultArchiver;
  /** The CURRENT canonical active messages (envelopes map 1:1 to indexes). */
  readonly readActiveMessages: (sessionId: string) => Promise<readonly unknown[]>;
  /** The durable TEXT offload seam; absent (jsonl) the axis is a no-op. */
  readonly offloadToolText?: (
    sessionId: string,
    items: readonly {
      readonly envelopeIndex: number;
      readonly replacement: string;
      readonly reference: string;
    }[],
  ) => Promise<void>;
  readonly maxTextReceiptChars?: number;
}

/**
 * The composed offload pass. One call = plan → materialize (artifact writes)
 * → `offloadToolText` events. Returns the number of applied offloads
 * (diagnostics); throws on faults — the caller owns the fail-safe.
 */
export function createToolResultTextOffloader(options: ToolResultTextOffloaderOptions) {
  const maxTextReceiptChars = options.maxTextReceiptChars ?? 4_000;
  return async function runToolResultTextOffload(sessionId: string): Promise<number> {
    if (options.offloadToolText === undefined) return 0;
    const messages = await options.readActiveMessages(sessionId);
    const plan = options.archiver.plan({
      sessionId,
      messages: messages as Parameters<ToolResultArchiver['plan']>[0]['messages'],
    });
    if (plan === undefined) return 0;
    const candidate = await options.archiver.materialize({ sessionId, plan });
    if (candidate === undefined || candidate.archivedResultCount === 0) return 0;
    const referenceByKey = new Map(
      (candidate.references ?? []).map((entry) => [entry.key, entry.reference]),
    );
    const items: {
      readonly envelopeIndex: number;
      readonly replacement: string;
      readonly reference: string;
    }[] = [];
    for (const planned of plan.candidates) {
      const reference = referenceByKey.get(planned.key);
      if (reference === undefined) continue;
      const replaced = candidate.messages[planned.index];
      const receipt = replaced === undefined ? undefined : joinedTextBlocks(replaced);
      if (receipt === undefined) continue;
      // The receipt rides the event payload; keep it bounded (the artifact
      // holds the full text — the receipt's job is the pointer, not the data).
      items.push({
        envelopeIndex: planned.index,
        replacement:
          receipt.length > maxTextReceiptChars
            ? `${receipt.slice(0, maxTextReceiptChars)}…`
            : receipt,
        reference,
      });
    }
    if (items.length === 0) return 0;
    await options.offloadToolText(sessionId, items);
    log.info('tool-result text offload applied', {
      session_id: sessionId,
      offloads: items.length,
      archived_results: candidate.archivedResultCount,
      savings_bytes: candidate.actualSavingsBytes,
    });
    return items.length;
  };
}
