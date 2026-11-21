import type { TuiAcpSessionHealth } from './agent.js';
import type { TuiMessage } from '../runtime/stream-events.js';

/**
 * READ-ONLY context-health counters for the `session/history` extension.
 *
 * One O(n) pass over the SAME display snapshot the page was sliced from, so
 * the numbers cover exactly the history a reader can page through (the durable
 * display store keeps pre-compaction records; only rewind/delete removes
 * them). Nothing here re-reads the Runtime: `summarizeSessionHealth` runs per
 * page request over the cached immutable snapshot, which keeps counters fresh
 * while a Turn runs (running Sessions are never snapshot-cached).
 *
 * Semantics:
 * - `llmCalls` counts COMMITTED assistant records with usage — one row per
 *   committed provider answer, the same population `token_usage` rows count.
 *   Interrupted/failed provider calls, retries, compaction summarizer calls
 *   and cache warm-ups never produce such a record and are NOT counted.
 * - `compactions.open` = `compaction_start` records without a terminal
 *   `compaction`/`compaction_failed` in the same Turn (>0 = interrupted or
 *   still running). Turn-less records (legacy files) balance globally.
 * - `lastTurn.compactions` counts terminal compaction facts (done + failed)
 *   of that Turn; an open start alone surfaces via `compactions.open`.
 * - `reminders` counts hidden custom markers by their raw `customType`
 *   (durable markers ride role `unknown` with `customType`; legacy markers
 *   ride role `unknown` with the type in `kind`). Shortening the names is the
 *   reader's job, not ours.
 * - `injections.steers` counts user records INSIDE a Turn after the Turn's
 *   first user record; a follow-up that opens a NEW Turn is not a steer.
 * - `resumedTurns` counts Turns with no user record before their first
 *   assistant record (turn-continuation submits empty input). Reminder
 *   markers and compaction facts at Turn start cannot perturb this: the rule
 *   only looks at user/assistant records.
 * - `source: 'legacy'` histories carry no `turnId`s, so per-Turn fields are
 *   `null` — unknown is not zero, and the whole point of this block is to
 *   prove that something did NOT happen.
 * - The block cannot see daemon/kagero process restarts; that fact belongs to
 *   the reader (kagero derives it from its own RunStore).
 */
export function summarizeSessionHealth(
  messages: readonly TuiMessage[],
  input: { readonly running: boolean; readonly source: 'durable' | 'legacy' },
): TuiAcpSessionHealth {
  let llmCalls = 0;
  let compactionDone = 0;
  let compactionFailed = 0;
  let openStarts = 0;
  // Turn-less compaction records (legacy files) balance on their own scale.
  let unassignedOpenStarts = 0;
  let steers = 0;
  let resumedTurns = 0;
  let lastTurnId: string | undefined;
  const reminders = new Map<string, number>();
  const turns = new Map<string, TurnHealthAccumulator>();

  for (const message of messages) {
    const turnId = normalizeTurnId(message.turnId);
    if (turnId) {
      lastTurnId = turnId;
      if (!turns.has(turnId)) turns.set(turnId, createTurnAccumulator());
    }
    const turn = turnId ? turns.get(turnId) : undefined;

    // Compaction facts ride assistant-shaped records but are bookkeeping, not
    // conversation: they count neither as LLM calls nor as a Turn's first
    // assistant record.
    if (
      message.kind === 'compaction' ||
      message.kind === 'compaction_start' ||
      message.kind === 'compaction_failed'
    ) {
      if (message.kind === 'compaction') {
        compactionDone += 1;
      } else if (message.kind === 'compaction_failed') {
        compactionFailed += 1;
      }
      if (message.kind === 'compaction_start') {
        if (turn) turn.openStarts += 1;
        else unassignedOpenStarts += 1;
      } else if (turn) {
        turn.openStarts = Math.max(0, turn.openStarts - 1);
        turn.compactions += 1;
      } else {
        unassignedOpenStarts = Math.max(0, unassignedOpenStarts - 1);
      }
      continue;
    }

    if (isUserRecord(message)) {
      if (turn) {
        turn.userRecords += 1;
        if (turn.userRecords > 1) steers += 1;
      }
      continue;
    }
    if (message.role === 'assistant' && !message.toolResult) {
      if (message.usage) {
        llmCalls += 1;
        if (turn) turn.llmCalls += 1;
      }
      if (turn && !turn.sawAssistant) {
        turn.sawAssistant = true;
        // A Turn opened without a user record before its first assistant
        // record is a continuation/resume, not a fresh request.
        if (turn.userRecords === 0) turn.resumed = true;
      }
      continue;
    }
    const reminderType = hiddenMarkerType(message);
    if (reminderType) {
      reminders.set(reminderType, (reminders.get(reminderType) ?? 0) + 1);
      if (turn) {
        turn.reminders.set(reminderType, (turn.reminders.get(reminderType) ?? 0) + 1);
      }
    }
  }

  for (const turn of turns.values()) {
    openStarts += turn.openStarts;
    if (turn.resumed) resumedTurns += 1;
  }
  openStarts += unassignedOpenStarts;

  // Legacy histories carry no turnIds at all: per-Turn counters are unknown,
  // not zero. A durable empty Session genuinely has zero Turns.
  const perTurnKnown = input.source !== 'legacy';
  const lastTurn =
    perTurnKnown && lastTurnId !== undefined
      ? buildLastTurn(lastTurnId, turns.get(lastTurnId))
      : undefined;
  return {
    schemaVersion: 1,
    source: input.source,
    running: input.running,
    turns: perTurnKnown ? turns.size : null,
    ...(perTurnKnown && lastTurnId !== undefined ? { lastTurnId } : {}),
    llmCalls,
    compactions: { done: compactionDone, failed: compactionFailed, open: openStarts },
    injections: {
      steers: perTurnKnown ? steers : null,
      reminders: sortedRecord(reminders),
    },
    resumedTurns: perTurnKnown ? resumedTurns : null,
    ...(lastTurn ? { lastTurn } : {}),
  };
}

interface TurnHealthAccumulator {
  userRecords: number;
  llmCalls: number;
  compactions: number;
  openStarts: number;
  sawAssistant: boolean;
  resumed: boolean;
  reminders: Map<string, number>;
}

function createTurnAccumulator(): TurnHealthAccumulator {
  return {
    userRecords: 0,
    llmCalls: 0,
    compactions: 0,
    openStarts: 0,
    sawAssistant: false,
    resumed: false,
    reminders: new Map<string, number>(),
  };
}

function buildLastTurn(
  turnId: string,
  turn: TurnHealthAccumulator | undefined,
): TuiAcpSessionHealth['lastTurn'] {
  if (!turn) {
    return { turnId, llmCalls: 0, compactions: 0, steers: 0, reminders: {}, resumed: false };
  }
  return {
    turnId,
    llmCalls: turn.llmCalls,
    compactions: turn.compactions,
    steers: Math.max(0, turn.userRecords - 1),
    reminders: sortedRecord(turn.reminders),
    resumed: turn.resumed,
  };
}

/** A real user input record — not a tool-result carrier, not a marker. */
function isUserRecord(message: TuiMessage): boolean {
  return message.role === 'user' && !message.toolResult;
}

/**
 * Raw type of a hidden custom marker: durable markers ride `customType`,
 * legacy markers ride `kind` (see legacy-history.ts). Visible system records
 * (review results and friends) carry role `system` and never match.
 */
function hiddenMarkerType(message: TuiMessage): string | undefined {
  if (message.role !== 'unknown' || message.toolResult) return undefined;
  const type = message.customType ?? message.kind;
  return type && type.trim() ? type : undefined;
}

function normalizeTurnId(turnId: string | undefined): string | undefined {
  const trimmed = turnId?.trim();
  return trimmed || undefined;
}

/** Deterministic wire shape: reminder counters keyed in sorted order. */
function sortedRecord(counts: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) record[key] = counts.get(key) as number;
  return record;
}
