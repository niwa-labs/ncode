import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { TuiMessage, TuiToolCall } from '../runtime/stream-events.js';

/**
 * READ-ONLY legacy fallback for the ACP `session/history` method.
 *
 * Sessions that predate the serving daemon's durable history exist only as
 * old-format v2 session directories:
 * `<dataDir>/v2/sessions/YYYY/MM/DD/HH-mm-ss-SSS-session_<base64id>/messages.jsonl`
 * (canonical envelope lines `{message_id, turn_id, message: {role, content?,
 * timestamp?, ...}}` — the same wire format the durable JSONL publisher
 * replicates; compare `@mavis/v2-adapter`). This module never writes and
 * refuses a symlinked sessions tree, so one profile's client can never read
 * another profile's history through the fallback.
 */

/** Raised when the v2 sessions tree is redirected by a symlink (cross-profile hazard). */
export class LegacyHistoryUnsafeRootError extends Error {
  constructor(readonly root: string) {
    super(`Unsafe v2 session artifact directory symlink: ${root}`);
    this.name = 'LegacyHistoryUnsafeRootError';
  }
}

/**
 * Resolves and parses the legacy history of one Session, or returns
 * `undefined` when the profile's v2 tree holds no such Session (which the
 * caller reports as `session_not_found` — never as an empty history). The
 * walk is synchronous and bounded (one profile's session tree).
 */
export function readLegacySessionHistoryFromDataDir(
  dataDir: string,
  sessionId: string,
): TuiMessage[] | undefined {
  // The root check is layered (opus review, legacy-guard fix): `lstat` alone
  // only sees the FINAL path segment, so a symlink at `<dataDir>/v2` (or at
  // `dataDir` itself) would slip a foreign tree in underneath it. The dataDir
  // is resolved first, the resolved sessions root must not move again, and
  // every accepted session directory must resolve INSIDE that root.
  let realDataDir: string;
  try {
    realDataDir = realpathSync(dataDir);
  } catch {
    return undefined;
  }
  const root = join(realDataDir, 'v2', 'sessions');
  let rootInfo: ReturnType<typeof lstatSync>;
  try {
    rootInfo = lstatSync(root);
  } catch {
    return undefined;
  }
  if (rootInfo.isSymbolicLink()) throw new LegacyHistoryUnsafeRootError(root);
  if (!rootInfo.isDirectory()) return undefined;
  // The path was built from an already-resolved dataDir, so any further
  // movement under realpath means a symlinked `v2`/`sessions` segment — the
  // exact redirection the segment-local lstat above cannot see.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return undefined;
  }
  if (realRoot !== root) throw new LegacyHistoryUnsafeRootError(root);
  const encoded = `session_${Buffer.from(sessionId || 'unknown-session', 'utf8')
    .toString('base64url')
    .slice(0, 180)}`;
  for (const dayDir of legacyDayDirectories(root)) {
    const entries = readDirectoryEntries(dayDir).filter(
      (entry) => !entry.isSymbolicLink() && entry.isDirectory() && entry.name.endsWith(encoded),
    );
    for (const entry of entries) {
      const sessionDir = join(dayDir, entry.name);
      // Defense in depth: the session directory itself passed the no-symlink
      // Dirent filter, so its realpath must stay inside the verified root.
      try {
        if (!isInside(realRoot, realpathSync(sessionDir))) continue;
      } catch {
        continue;
      }
      // The history file is lstat-ed itself: a `messages.jsonl` symlink (or
      // any non-regular file) is not a readable history. A session directory
      // WITHOUT one keeps the search going — an empty artifact directory is
      // "no legacy session" (→ session_not_found), not an empty history.
      const messagesPath = join(sessionDir, 'messages.jsonl');
      let messagesInfo: ReturnType<typeof lstatSync>;
      try {
        messagesInfo = lstatSync(messagesPath);
      } catch {
        continue;
      }
      if (!messagesInfo.isFile()) continue;
      return parseLegacyMessagesFile(messagesPath);
    }
  }
  return undefined;
}

/** Whether `candidate` is `root` itself or lives directly under its tree. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Session date directories, newest first (segments are zero-padded). */
function legacyDayDirectories(root: string): string[] {
  const days: string[] = [];
  for (const year of readDirectoryNames(root)) {
    const yearDir = join(root, year);
    for (const month of readDirectoryNames(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of readDirectoryNames(monthDir)) {
        days.push(join(monthDir, day));
      }
    }
  }
  return days;
}

function readDirectoryNames(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function readDirectoryEntries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Parses one legacy `messages.jsonl`. Best-effort by design (mirrors the
 * v2 adapter's `formatErrors: 'skip'`): blank or malformed lines are skipped,
 * records that do not carry a usable envelope are skipped too.
 */
function parseLegacyMessagesFile(messagesPath: string): TuiMessage[] {
  let raw: string;
  try {
    raw = readFileSync(messagesPath, 'utf8');
  } catch {
    return [];
  }
  const messages: TuiMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = legacyEnvelopeToTuiMessage(envelope);
    if (message) messages.push(message);
  }
  return messages;
}

function legacyEnvelopeToTuiMessage(value: unknown): TuiMessage | undefined {
  if (!isRecord(value) || !isRecord(value.message)) return undefined;
  const message = value.message;
  const role = message.role;
  if (typeof role !== 'string' || !role) return undefined;
  const id = typeof value.message_id === 'string' && value.message_id ? { id: value.message_id } : {};
  const timestamp =
    typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {};
  const text = legacyContentToText(message.content);
  const content = text ? { content: text } : {};
  if (role === 'toolResult') {
    const toolCallId = legacyText(message.toolCallId ?? message.tool_call_id);
    if (!toolCallId) return undefined;
    const toolName = legacyText(message.toolName ?? message.tool_name);
    const isError = message.isError === true || message.is_error === true;
    return {
      ...id,
      role: 'user',
      toolResult: {
        toolCallId,
        ...(toolName ? { toolName } : {}),
        ...(isError ? { isError: true } : {}),
      },
      ...content,
      ...timestamp,
    };
  }
  if (role === 'compactionSummary') {
    const summary = legacyText(message.summary) ?? text;
    return {
      ...id,
      role: 'assistant',
      kind: 'compaction',
      ...(summary ? { content: summary } : {}),
      ...timestamp,
    };
  }
  if (role === 'custom') {
    const customType = legacyText(message.customType ?? message.custom_type);
    // Legacy customTypes intentionally ride the TuiMessage.kind string slot:
    // the ACP entry mapper reads it back as the entry's `customType`.
    return {
      ...id,
      role: 'unknown',
      ...(customType ? { kind: customType } : {}),
      ...content,
      ...timestamp,
    } as TuiMessage;
  }
  // Canonical assistant blocks carry the tool round-trip: thinking text and
  // `{type:'toolCall', id, name, arguments}` blocks — project them onto the
  // same TuiMessage shapes the durable projection produces.
  const blocks = legacyContentToBlocks(message.content);
  const thinking = blocks.thinking ? { thinking: blocks.thinking } : {};
  const toolCalls = blocks.toolCalls ? { toolCalls: blocks.toolCalls } : {};
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return { ...id, role, ...thinking, ...toolCalls, ...content, ...timestamp };
  }
  return { ...id, role: 'unknown', ...thinking, ...toolCalls, ...content, ...timestamp };
}

/** Flattens canonical content (string or block array) to reader text. */
function legacyContentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return legacyText(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (isRecord(block) ? legacyText(block.text) : undefined))
    .filter((value) => value !== undefined)
    .join('\n');
  return legacyText(text);
}

/**
 * Lifts canonical thinking and toolCall blocks out of a content block array
 * (the text flattening above leaves them untouched — they carry no `text`).
 */
function legacyContentToBlocks(content: unknown): {
  thinking?: string;
  toolCalls?: TuiToolCall[];
} {
  if (!Array.isArray(content)) return {};
  const thinking: string[] = [];
  const toolCalls: TuiToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : undefined;
    const thinkingText = legacyText(block.thinking);
    if (type === 'thinking' || type === 'reasoning') {
      if (thinkingText) thinking.push(thinkingText);
      continue;
    }
    if (type === 'toolcall' || type === 'tool_call') {
      const name = legacyText(block.name);
      if (!name) continue;
      const id = legacyText(block.id);
      toolCalls.push({
        ...(id ? { id } : {}),
        name,
        ...(block.arguments !== undefined ? { input: block.arguments } : {}),
      });
    }
  }
  return {
    ...(thinking.length > 0 ? { thinking: thinking.join('\n') } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function legacyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
