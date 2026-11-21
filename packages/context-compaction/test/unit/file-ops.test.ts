/**
 * File-operation tracking (pin `compaction/utils.ts`): extraction from tool
 * calls, read-only vs modified lists, the summary suffix, and the iterative
 * fold through the previous checkpoint's `details`.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
  compact,
  computeFileLists,
  createFileOps,
  createMessageEntryDraft,
  extractFileOpsFromMessage,
  fileOpsFromPreviousDetails,
  formatFileOperations,
  type CompactionMessage,
  type CompactionEntryPayload,
} from '../../src/index.js';
import { RecordingSummarizer, messageEntry, stamp, userMessage, filler } from './helpers.js';

function assistantWithToolCall(name: string, path: string | unknown): CompactionMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', name, arguments: { path } }],
  };
}

describe('extractFileOpsFromMessage', () => {
  it('collects read/write/edit paths from tool calls', () => {
    const fileOps = createFileOps();
    extractFileOpsFromMessage(assistantWithToolCall('read', '/a.ts'), fileOps);
    extractFileOpsFromMessage(assistantWithToolCall('write', '/b.ts'), fileOps);
    extractFileOpsFromMessage(assistantWithToolCall('edit', '/c.ts'), fileOps);
    expect([...fileOps.read]).toEqual(['/a.ts']);
    expect([...fileOps.written]).toEqual(['/b.ts']);
    expect([...fileOps.edited]).toEqual(['/c.ts']);
  });

  it('ignores other tools, non-path arguments, and non-assistant messages', () => {
    const fileOps = createFileOps();
    extractFileOpsFromMessage(assistantWithToolCall('bash', { command: 'ls' }), fileOps);
    extractFileOpsFromMessage(assistantWithToolCall('read', undefined), fileOps);
    extractFileOpsFromMessage(assistantWithToolCall('read', 42), fileOps);
    extractFileOpsFromMessage(userMessage('read /a.ts'), fileOps);
    expect(fileOps.read.size).toBe(0);
    expect(fileOps.written.size).toBe(0);
    expect(fileOps.edited.size).toBe(0);
  });
});

describe('computeFileLists', () => {
  it('a file both read and modified counts as modified only', () => {
    const fileOps = createFileOps();
    extractFileOpsFromMessage(assistantWithToolCall('read', '/both.ts'), fileOps);
    extractFileOpsFromMessage(assistantWithToolCall('edit', '/both.ts'), fileOps);
    extractFileOpsFromMessage(assistantWithToolCall('read', '/only-read.ts'), fileOps);
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    expect(readFiles).toEqual(['/only-read.ts']);
    expect(modifiedFiles).toEqual(['/both.ts']);
  });
});

describe('formatFileOperations', () => {
  it('renders only the non-empty sections, empty when both empty', () => {
    expect(formatFileOperations([], [])).toBe('');
    expect(formatFileOperations(['/a'], [])).toBe('\n\n<read-files>\n/a\n</read-files>');
    expect(formatFileOperations([], ['/b'])).toBe('\n\n<modified-files>\n/b\n</modified-files>');
    expect(formatFileOperations(['/a'], ['/b'])).toBe(
      '\n\n<read-files>\n/a\n</read-files>\n\n<modified-files>\n/b\n</modified-files>',
    );
  });
});

describe('fileOpsFromPreviousDetails (iterative compactions keep the state)', () => {
  it('seeds read lists as read-only and modified lists as edited', () => {
    const previous: CompactionEntryPayload = {
      summary: 'old',
      firstKeptEntryId: 'x',
      systemMessage: null,
      isSplitTurn: false,
      tokensBefore: 0,
      estimatedTokensAfter: 0,
      createdAtMs: 0,
      details: { readFiles: ['/kept-read.ts'], modifiedFiles: ['/kept-mod.ts'] },
    };
    const fileOps = fileOpsFromPreviousDetails(previous);
    expect([...fileOps.read]).toEqual(['/kept-read.ts']);
    expect([...fileOps.edited]).toEqual(['/kept-mod.ts']);
    // A later read of the previously-modified file stays modified.
    extractFileOpsFromMessage(assistantWithToolCall('read', '/kept-mod.ts'), fileOps);
    expect(computeFileLists(fileOps).readFiles).toEqual(['/kept-read.ts']);
  });

  it('tolerates absent or malformed details', () => {
    expect(computeFileLists(fileOpsFromPreviousDetails(undefined))).toEqual({ readFiles: [], modifiedFiles: [] });
    expect(computeFileLists(fileOpsFromPreviousDetails({
      summary: 's',
      firstKeptEntryId: 'x',
      systemMessage: null,
      isSplitTurn: false,
      tokensBefore: 0,
      estimatedTokensAfter: 0,
      createdAtMs: 0,
      // @ts-expect-error deliberate malformed details
      details: { readFiles: 'not-a-list' },
    }))).toEqual({ readFiles: [], modifiedFiles: [] });
  });
});

describe('compact() folds file operations into summary and details', () => {
  function logWithToolCalls(): ReturnType<typeof messageEntry>[] {
    return [
      messageEntry(userMessage('start')),
      stamp(createMessageEntryDraft('a1', assistantWithToolCall('read', '/old-read.ts'))),
      stamp(createMessageEntryDraft('a2', assistantWithToolCall('edit', '/old-edit.ts'))),
      ...Array.from({ length: 8 }, (_, i) => messageEntry(userMessage(filler(4000))))
    ];
  }

  it('appends the lists to the summary and records details on the checkpoint', async () => {
    const summarizer = new RecordingSummarizer('SUMMARY');
    const entries = logWithToolCalls();
    const outcome = await compact({ entries, summarizer: summarizer.call, keepRecentTokens: 100 });
    expect(outcome).not.toBeNull();
    expect(outcome!.summary).toBe(
      'SUMMARY\n\n<read-files>\n/old-read.ts\n</read-files>\n\n<modified-files>\n/old-edit.ts\n</modified-files>',
    );
    expect((outcome!.draft.payload as CompactionEntryPayload).details).toEqual({
      readFiles: ['/old-read.ts'],
      modifiedFiles: ['/old-edit.ts'],
    });
    expect(outcome!.details).toEqual({ readFiles: ['/old-read.ts'], modifiedFiles: ['/old-edit.ts'] });
  });

  it('an iterative compaction carries the previous lists forward', async () => {
    const entries = logWithToolCalls();
    const first = await compact({ entries, summarizer: new RecordingSummarizer('S1').call, keepRecentTokens: 100 });
    expect(first).not.toBeNull();
    const withFirst = [...entries, stamp({ ...first!.draft, parentId: null })];

    // New range touches only one new file (placed inside the summarized
    // range, before the fresh kept tail).
    const grown = [
      ...withFirst,
      stamp(createMessageEntryDraft('a3', assistantWithToolCall('write', '/new-write.ts'))),
      ...Array.from({ length: 6 }, (_, i) => messageEntry(userMessage(`${filler(4000)}-new-${i}`))),
    ];
    const second = await compact({ entries: grown, summarizer: new RecordingSummarizer('S2').call, keepRecentTokens: 50 });
    expect(second).not.toBeNull();
    expect(second!.details).toEqual({
      readFiles: ['/old-read.ts'],
      modifiedFiles: ['/new-write.ts', '/old-edit.ts'].sort(),
    });
    expect(second!.summary).toContain('<read-files>\n/old-read.ts\n</read-files>');
    expect(second!.summary).toContain('<modified-files>');
  });

  it('no file ops — no suffix and no details field', async () => {
    const entries = [
      messageEntry(userMessage('start')),
      ...Array.from({ length: 8 }, (_, i) => messageEntry(userMessage(filler(4000)))),
    ];
    const outcome = await compact({ entries, summarizer: new RecordingSummarizer('S').call, keepRecentTokens: 100 });
    expect(outcome).not.toBeNull();
    expect(outcome!.summary).toBe('S');
    expect((outcome!.draft.payload as CompactionEntryPayload).details).toBeUndefined();
  });
});
