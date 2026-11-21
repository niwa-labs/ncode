/**
 * The split-turn glue and the summarizer prompts behind it.
 *
 * `split-turn.test.ts` proves the merged summary shape end to end. This file
 * pins the pieces the merge is built from: the exact separator string, the
 * prompt builders (plain / iterative / custom focus) and the conversation
 * serialization the summarizer actually reads.
 */

import { describe, expect, it } from 'vitest';

import {
  SPLIT_TURN_SEPARATOR,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  TOOL_RESULT_MAX_CHARS,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildSummaryPrompt,
  buildTurnPrefixPrompt,
  compact,
  mergeSplitTurnSummary,
  serializeConversation,
  withSystemInstructions,
} from '../../src/index.js';
import type { CompactionMessage, LogEntry } from '../../src/index.js';
import {
  RecordingSummarizer,
  assistantMessage,
  filler,
  messageEntry,
  stamp,
  toolResultMessage,
  userMessage,
} from './helpers.js';

describe('the split-turn glue', () => {
  it('is the exact pi separator between the history and the turn prefix', () => {
    expect(SPLIT_TURN_SEPARATOR).toBe('\n\n---\n\n**Turn Context (split turn):**\n\n');
    expect(mergeSplitTurnSummary('HISTORY', 'PREFIX')).toBe(`HISTORY${SPLIT_TURN_SEPARATOR}PREFIX`);
  });

  it('merges without dropping or reordering the two summaries', () => {
    const merged = mergeSplitTurnSummary('HISTORY-SUMMARY', 'TURN-PREFIX-SUMMARY');
    expect(merged.startsWith('HISTORY-SUMMARY')).toBe(true);
    expect(merged.endsWith('TURN-PREFIX-SUMMARY')).toBe(true);
    expect(merged.indexOf('HISTORY-SUMMARY')).toBeLessThan(merged.indexOf('TURN-PREFIX-SUMMARY'));
    // The history summary comes FIRST: the turn prefix is the tail of the
    // conversation and must follow the condensed history.
    expect(merged.split(SPLIT_TURN_SEPARATOR)).toEqual(['HISTORY-SUMMARY', 'TURN-PREFIX-SUMMARY']);
  });

  it('an empty prefix yields no separator (the history is the whole summary)', () => {
    // A summarizer that returns an empty turn prefix produces just the
    // history: no separator marker is added when there is nothing to
    // separate — the merge is a no-op passthrough.
    const merged = mergeSplitTurnSummary('HISTORY', '');
    expect(merged).toBe('HISTORY');
  });
});

describe('buildSummaryPrompt', () => {
  it('builds the plain prompt without a previous summary', () => {
    const prompt = buildSummaryPrompt('[User]: hello');
    expect(prompt).toContain('<conversation>\n[User]: hello\n</conversation>');
    expect(prompt).toContain(SUMMARIZATION_PROMPT);
    expect(prompt).not.toContain('<previous-summary>');
    expect(prompt).not.toContain(UPDATE_SUMMARIZATION_PROMPT);
  });

  it('switches to the update rules and embeds the previous summary', () => {
    const prompt = buildSummaryPrompt('[User]: new work', 'PRIOR-SUMMARY');
    expect(prompt).toContain('<previous-summary>\nPRIOR-SUMMARY\n</previous-summary>');
    expect(prompt).toContain(UPDATE_SUMMARIZATION_PROMPT);
    expect(prompt).not.toContain(SUMMARIZATION_PROMPT);
    // The conversation still comes first, the previous summary second, the
    // instructions last.
    expect(prompt.indexOf('<conversation>')).toBeLessThan(prompt.indexOf('<previous-summary>'));
    expect(prompt.indexOf('<previous-summary>')).toBeLessThan(prompt.indexOf('RULES:'));
  });

  it('appends custom instructions as an explicit focus', () => {
    const prompt = buildSummaryPrompt('[User]: hello', undefined, 'keep the file paths');
    expect(prompt).toContain('Additional focus: keep the file paths');
    expect(prompt.endsWith('Additional focus: keep the file paths')).toBe(true);
  });

  it('keeps the custom focus after the update rules', () => {
    const prompt = buildSummaryPrompt('[User]: hello', 'PRIOR', 'keep the file paths');
    expect(prompt).toContain('Additional focus: keep the file paths');
    expect(prompt.indexOf('RULES:')).toBeLessThan(prompt.indexOf('Additional focus:'));
  });
});

describe('buildTurnPrefixPrompt', () => {
  it('asks for a checkpoint of the split turn only', () => {
    const prompt = buildTurnPrefixPrompt('[User]: start the turn');
    expect(prompt).toContain('<conversation>\n[User]: start the turn\n</conversation>');
    expect(prompt).toContain('# Instructions');
    expect(prompt).toContain(TURN_PREFIX_SUMMARIZATION_PROMPT);
    expect(prompt).not.toContain('Additional focus:');
  });

  it('appends custom instructions as an explicit focus', () => {
    const prompt = buildTurnPrefixPrompt('[User]: start the turn', 'focus on the failing test');
    expect(prompt).toContain('Additional focus: focus on the failing test');
  });

  it('never asks for the previous summary: the prefix prompt has no history', () => {
    const prompt = buildTurnPrefixPrompt('[User]: start the turn');
    expect(prompt).not.toContain('<previous-summary>');
  });
});

describe('withSystemInstructions', () => {
  it('prepends the role instruction to the task', () => {
    const wrapped = withSystemInstructions('TASK');
    expect(wrapped).toBe(`${SUMMARIZATION_SYSTEM_PROMPT}\n\nTASK`);
    expect(wrapped.startsWith(SUMMARIZATION_SYSTEM_PROMPT)).toBe(true);
    // The instruction forbids continuing the conversation — that is the whole
    // point of the wrapper.
    expect(SUMMARIZATION_SYSTEM_PROMPT).toContain('Do NOT continue the conversation');
  });
});

describe('serializeConversation', () => {
  it('labels every role the summarizer sees', () => {
    const conversation = serializeConversation([
      userMessage('hello'),
      assistantMessage('working'),
      toolResultMessage('output'),
      { role: 'custom', customType: 'hook', text: 'a hook fired' },
    ]);
    expect(conversation).toContain('[User]: hello');
    expect(conversation).toContain('[Assistant]: working');
    expect(conversation).toContain('[Tool result]: output');
    expect(conversation).toContain('[hook]: a hook fired');
  });

  it('renders tool calls with their arguments', () => {
    const withCall = serializeConversation([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'toolCall', name: 'read_file', arguments: { path: '/tmp/a.txt' } },
        ],
      },
    ]);
    expect(withCall).toContain('[Assistant]: calling');
    expect(withCall).toContain('[Assistant tool calls]: read_file(path="/tmp/a.txt")');
  });

  it('truncates a long tool result and marks the loss', () => {
    const long = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500);
    const conversation = serializeConversation([toolResultMessage(long)]);
    expect(conversation).toContain('[... 500 more characters truncated]');
    // The head is kept, the tail is dropped: the marker says exactly how much.
    expect(conversation).toContain('x'.repeat(TOOL_RESULT_MAX_CHARS));
    expect(conversation).not.toContain('x'.repeat(TOOL_RESULT_MAX_CHARS + 1));
  });

  it('keeps a short tool result verbatim', () => {
    const conversation = serializeConversation([toolResultMessage('short')]);
    expect(conversation).toBe('[Tool result]: short');
  });

  it('excludes thinking blocks entirely', () => {
    const conversation = serializeConversation([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'SECRET REASONING' },
          { type: 'text', text: 'visible answer' },
        ],
      },
    ]);
    expect(conversation).toContain('visible answer');
    expect(conversation).not.toContain('SECRET REASONING');
  });

  it('contributes nothing for an empty message', () => {
    const conversation = serializeConversation([{ role: 'user', content: '' }]);
    expect(conversation).toBe('');
  });
});

describe('iterative compaction feeds the previous summary back in', () => {
  /** The log of a SECOND compaction: the checkpoint plus two fresh turns. */
  async function secondRoundLog(): Promise<LogEntry[]> {
    const base: LogEntry[] = [
      messageEntry(userMessage(`first ${filler(40_000)}`)),
      messageEntry(assistantMessage(`first work ${filler(40_000)}`)),
    ];
    const first = await compact({
      entries: base,
      summarizer: new RecordingSummarizer('SUMMARY-ONE').call,
      keepRecentTokens: 1_000,
    });
    expect(first).not.toBeNull();
    return [
      ...base,
      stamp(first!.draft, 3, 0),
      messageEntry(userMessage(`second ${filler(40_000)}`)),
      messageEntry(assistantMessage(`second work ${filler(40_000)}`)),
      messageEntry(userMessage(`third ${filler(40_000)}`)),
      messageEntry(assistantMessage(`third work ${filler(40_000)}`)),
    ];
  }

  it('the second compaction asks the summarizer to merge into the first summary', async () => {
    const log = await secondRoundLog();
    const summarizer = new RecordingSummarizer('SUMMARY-TWO');
    const second = await compact({
      entries: log,
      summarizer: summarizer.call,
      keepRecentTokens: 1_000,
    });
    expect(second).not.toBeNull();

    // The HISTORY prompt carries the FIRST summary: the summary chain is
    // iterative, not a fresh start.
    const historyPrompt = summarizer.prompts.find((prompt) => prompt.includes('<previous-summary>'));
    expect(historyPrompt).toBeDefined();
    expect(historyPrompt).toContain('SUMMARY-ONE');
    expect(historyPrompt).toContain('RULES:');
    // The new work is what gets summarized this time round.
    expect(historyPrompt).toContain('[User]: second');
  });

  it('the second summary does not nest the first one verbatim', async () => {
    const log = await secondRoundLog();
    const summarizer = new RecordingSummarizer('SUMMARY-TWO');
    await compact({ entries: log, summarizer: summarizer.call, keepRecentTokens: 1_000 });
    const historyPrompt = summarizer.prompts.find((prompt) => prompt.includes('<previous-summary>'))!;
    // The OLD summary is NOT part of the conversation to summarize (it is
    // already condensed); it only arrives through <previous-summary>.
    const conversation = historyPrompt.split('</conversation>')[0]!;
    expect(conversation).not.toContain('SUMMARY-ONE');
  });

  it('the merged result is the NEW summary plus the turn prefix', async () => {
    const log = await secondRoundLog();
    const second = await compact({
      entries: log,
      summarizer: new RecordingSummarizer('SUMMARY-TWO').call,
      keepRecentTokens: 1_000,
    });
    expect(second).not.toBeNull();
    // The previous summary is an INPUT to the summarizer prompt, not part of
    // the stored result: the checkpoint holds what the model produced.
    expect(second!.summary).not.toContain('SUMMARY-ONE');
    expect(second!.summary).toContain('SUMMARY-TWO');
    expect(second!.summary).toContain(SPLIT_TURN_SEPARATOR);
    expect(second!.isSplitTurn).toBe(true);
  });
});

describe('the split-turn prefix prompt reaches the summarizer', () => {
  it('the turn prefix is summarized with the turn-prefix prompt, not the history prompt', async () => {
    const entries = [
      messageEntry(userMessage('history turn')),
      messageEntry(assistantMessage('history done')),
      messageEntry(userMessage('the split turn')),
      messageEntry(assistantMessage('step 1')),
      messageEntry(toolResultMessage(filler(60_000), 'c1')),
      messageEntry(assistantMessage('step 2')),
    ];
    const summarizer = new RecordingSummarizer('HISTORY', 'TURN-PREFIX');
    const outcome = await compact({ entries, summarizer: summarizer.call, keepRecentTokens: 4_000 });
    expect(outcome).not.toBeNull();
    expect(outcome!.isSplitTurn).toBe(true);
    expect(summarizer.callCount).toBe(2);
    // The FIRST call is the history summary...
    expect(summarizer.prompts[0]).toContain(SUMMARIZATION_PROMPT);
    expect(summarizer.prompts[0]).not.toContain('# Instructions');
    // ...the SECOND call is the turn prefix, with the turn-prefix instructions.
    expect(summarizer.prompts[1]).toContain('# Instructions');
    expect(summarizer.prompts[1]).toContain(TURN_PREFIX_SUMMARIZATION_PROMPT);
    expect(summarizer.prompts[1]).toContain('[User]: the split turn');
    // The turn prefix never sees the earlier turn.
    expect(summarizer.prompts[1]).not.toContain('[User]: history turn');
  });

  it('both prompts carry the system instruction', async () => {
    const entries = [
      messageEntry(userMessage('history turn')),
      messageEntry(assistantMessage('history done')),
      messageEntry(userMessage('the split turn')),
      messageEntry(assistantMessage('step 1')),
      messageEntry(toolResultMessage(filler(60_000), 'c1')),
      messageEntry(assistantMessage('step 2')),
    ];
    const summarizer = new RecordingSummarizer('H', 'P');
    await compact({ entries, summarizer: summarizer.call, keepRecentTokens: 4_000 });
    for (const prompt of summarizer.prompts) {
      expect(prompt.startsWith(SUMMARIZATION_SYSTEM_PROMPT)).toBe(true);
    }
  });
});

describe('the merged summary is what the checkpoint stores', () => {
  it('stores the merged text and marks the checkpoint as a split turn', async () => {
    const entries = [
      messageEntry(userMessage('history turn')),
      messageEntry(assistantMessage('history done')),
      messageEntry(userMessage('the split turn')),
      messageEntry(assistantMessage('step 1')),
      messageEntry(toolResultMessage(filler(60_000), 'c1')),
      messageEntry(assistantMessage('step 2')),
    ];
    const outcome = await compact({
      entries,
      summarizer: new RecordingSummarizer('H', 'P').call,
      keepRecentTokens: 4_000,
    });
    expect(outcome!.summary).toBe(`H${SPLIT_TURN_SEPARATOR}P`);
    expect(outcome!.draft.payload).toMatchObject({ isSplitTurn: true, summary: `H${SPLIT_TURN_SEPARATOR}P` });
  });
});

describe('message shapes the serializer must survive', () => {
  it('renders a multi-block assistant message with text and a tool call', () => {
    const message: CompactionMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'one' },
        { type: 'toolCall', name: 'a', arguments: {} },
        { type: 'text', text: 'two' },
      ],
    };
    const conversation = serializeConversation([message]);
    // pi's serializeConversation renders assistant text with contentText's
    // DEFAULT "\n" separator — two text blocks are two paragraphs (pinned
    // against the pinned dist in pi-oracle-compaction-parity).
    expect(conversation).toContain('[Assistant]: one\ntwo');
    expect(conversation).toContain('[Assistant tool calls]: a()');
  });

  it('renders a tool call without arguments', () => {
    const conversation = serializeConversation([
      { role: 'assistant', content: [{ type: 'toolCall', name: 'ping' }] },
    ]);
    expect(conversation).toContain('[Assistant tool calls]: ping()');
  });
});
