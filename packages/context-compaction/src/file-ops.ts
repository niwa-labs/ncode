/**
 * File-operation tracking for compaction summaries — a port of the pin's
 * `compaction/utils.ts` (read/write/edit calls extracted from tool calls,
 * folded across compactions through the previous checkpoint's details, and
 * appended to the summary as `<read-files>`/`<modified-files>` sections).
 *
 * The lists are part of the checkpoint's `details` (`CompactionDetails` on the
 * pin): an ITERATIVE compaction re-baselines from the previous checkpoint's
 * recorded lists and adds the calls of the newly summarized range, so the
 * file state survives any number of repeated compactions.
 *
 * @module
 */

import type { CompactionMessage, CompactionEntryPayload } from './types.js';

/** The mutable accumulator (pin `FileOperations`). */
export interface FileOperations {
  readonly read: Set<string>;
  readonly written: Set<string>;
  readonly edited: Set<string>;
}

/** Pin `createFileOps`. */
export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

function addFileOp(toolName: string, args: unknown, fileOps: FileOperations): void {
  const path = typeof (args as { path?: unknown } | null | undefined)?.path === 'string'
    ? (args as { path: string }).path
    : undefined;
  if (path === undefined || path.length === 0) return;
  switch (toolName) {
    case 'read':
      fileOps.read.add(path);
      break;
    case 'write':
      fileOps.written.add(path);
      break;
    case 'edit':
      fileOps.edited.add(path);
      break;
  }
}

/**
 * Extract file operations from the tool calls of one message (pin
 * `extractFileOpsFromMessage`): assistant `toolCall` blocks with a string
 * `path` argument to read/write/edit. Tool results contribute nothing in this
 * dialect (no nested-call recording on our message shape yet).
 */
export function extractFileOpsFromMessage(message: CompactionMessage, fileOps: FileOperations): void {
  if (message.role !== 'assistant') return;
  for (const block of message.content) {
    if (block.type !== 'toolCall') continue;
    addFileOp(block.name, block.arguments, fileOps);
  }
}

/**
 * Compute the final lists (pin `computeFileLists`): `modifiedFiles` = edited
 * ∪ written (sorted); `readFiles` = read minus modified (sorted) — a file that
 * was later modified is not listed as only-read.
 */
export function computeFileLists(fileOps: FileOperations): {
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
} {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format the lists as the summary suffix (pin `formatFileOperations`):
 * `\n\n<read-files>…</read-files>\n\n<modified-files>…</modified-files>`,
 * only the non-empty sections, empty string when both are empty.
 */
export function formatFileOperations(readFiles: readonly string[], modifiedFiles: readonly string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`);
  }
  if (sections.length === 0) return '';
  return `\n\n${sections.join('\n\n')}`;
}

/**
 * Seed the accumulator from a previous checkpoint's `details` (pin
 * `extractFileOperations`): an iterative compaction starts from the files the
 * previous summary already recorded, so repeated compactions never lose the
 * file state. A malformed `details` contributes nothing.
 */
export function fileOpsFromPreviousDetails(
  previous: CompactionEntryPayload | undefined,
): FileOperations {
  const fileOps = createFileOps();
  const details = previous?.details;
  if (details === undefined || details === null) return fileOps;
  if (Array.isArray(details.readFiles)) {
    for (const file of details.readFiles) if (typeof file === 'string') fileOps.read.add(file);
  }
  if (Array.isArray(details.modifiedFiles)) {
    for (const file of details.modifiedFiles) if (typeof file === 'string') fileOps.edited.add(file);
  }
  return fileOps;
}
