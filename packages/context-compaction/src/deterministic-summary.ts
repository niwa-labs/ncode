/**
 * Wave 3 (canon 05 §2.2/§2.4, item 3.2): the deterministic fallback summary —
 * the cline `basic` shape, without any provider call.
 *
 * When the compaction circuit breaker is open (three consecutive breaker-class
 * failures, canon §2.4) the blocking edge must still cut the window — the
 * owner's turn must not drown — but it must not spend another provider call on
 * a summarizer that just failed three times in a row. The fallback produces a
 * fully deterministic summary of the same covered range: the tool activity
 * (per-tool call counts and the tool names in order) plus the last assistant
 * texts verbatim, folded into the SAME structured section shape the LLM
 * summary uses, so the downstream consumers (the wire summary record, the
 * continuation reminder) see one format.
 *
 * Nuance loss is the accepted price (canon §5: "Детерминированная запасная
 * компакция теряет нюансы суммари — допустимо только при открытом breaker").
 * The producer never throws on any message shape: a fallback that throws would
 * re-open the failure loop it exists to close.
 *
 * @module
 */

import type { CompactionMessage } from './types.js';

/** Input of the deterministic producer: the exact range the cut covers. */
export interface DeterministicSummaryInput {
  /** The summarized history range (everything before the cut), oldest first. */
  readonly historyMessages: readonly CompactionMessage[];
  /** The prefix of a turn the cut had to split (may be empty). */
  readonly turnPrefixMessages: readonly CompactionMessage[];
  /** The previous checkpoint's summary, folded in when present. */
  readonly previousSummary: string | undefined;
}

/** A deterministic summary producer (no provider involvement, never throws). */
export type DeterministicSummaryProducer = (input: DeterministicSummaryInput) => string;

/** Tool results summarized by name and count — content stays out (bytes). */
const MAX_TOOL_RESULT_SAMPLE_CHARS = 200;

/**
 * Builds the deterministic fallback summary (canon 05 §2.2: "суммари
 * tool-активности + последние assistant-тексты"). Sections:
 *
 * - `## Goal` — folded from the previous summary's Goal section when present;
 * - `## Tool Activity` — the per-tool call sequence with counts;
 * - `## Recent Assistant Progress` — the last assistant texts, verbatim;
 * - `## Current Turn (split)` — the split-turn prefix request, when cut;
 * - the previous summary's remaining sections kept verbatim (iterative
 *   fallbacks keep the earlier context instead of losing it).
 */
export const createDeterministicSummaryProducer = (): DeterministicSummaryProducer => {
  return ({ historyMessages, turnPrefixMessages, previousSummary }) => {
    const sections: string[] = [];

    const goal = sectionOf(previousSummary, '## Goal');
    sections.push(
      goal !== undefined
        ? `## Goal\n${goal}`
        : '## Goal\n- (deterministic fallback summary — the earlier goal is in the retained context and the previous summary below)',
    );

    const activity = toolActivityLines(historyMessages);
    sections.push(
      activity.length > 0
        ? `## Tool Activity\n${activity.join('\n')}`
        : '## Tool Activity\n- (no tool calls in the summarized range)',
    );

    const assistantProgress = assistantProgressLines(historyMessages);
    sections.push(
      assistantProgress.length > 0
        ? `## Recent Assistant Progress\n${assistantProgress.join('\n')}`
        : '## Recent Assistant Progress\n- (no assistant text in the summarized range)',
    );

    const splitRequest = splitTurnRequest(turnPrefixMessages);
    if (splitRequest !== undefined) sections.push(`## Current Turn (split)\n${splitRequest}`);

    const carried = sectionsOtherThanGoal(previousSummary);
    if (carried !== undefined) sections.push(carried.trim());

    return sections.join('\n\n');
  };
};

/** Per-tool call counts in first-appearance order. */
function toolActivityLines(messages: readonly CompactionMessage[]): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([name, count]) =>
    count === 1 ? `- ${name} (×1)` : `- ${name} (×${count})`,
  );
}

/** The last assistant texts, verbatim, oldest first (canon: "последние assistant-тексты"). */
function assistantProgressLines(messages: readonly CompactionMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) texts.push(text);
  }
  // The last texts carry the progress; the tail is what the model needs.
  return texts.slice(-DETERMINISTIC_SUMMARY_ASSISTANT_TEXTS);
}

/** The split-turn prefix's user request(s), truncated. */
function splitTurnRequest(messages: readonly CompactionMessage[]): string | undefined {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    const trimmed = text.trim();
    if (trimmed) lines.push(`- ${truncate(trimmed)}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** One section's body (without its heading) of a structured summary. */
function sectionOf(summary: string | undefined, heading: string): string | undefined {
  if (summary === undefined) return undefined;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(summary);
  return match?.[1]?.trim() || undefined;
}

/** Everything after the `## Goal` section — carried into the fallback verbatim. */
function sectionsOtherThanGoal(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const index = summary.indexOf('\n## ');
  return index === -1 ? undefined : summary.slice(index + 1);
}

function truncate(text: string): string {
  return text.length <= MAX_TOOL_RESULT_SAMPLE_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_SAMPLE_CHARS)}…`;
}

/** How many trailing assistant texts the fallback keeps verbatim. */
export const DETERMINISTIC_SUMMARY_ASSISTANT_TEXTS = 5;
