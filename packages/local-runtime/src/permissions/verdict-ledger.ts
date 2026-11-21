/**
 * Process-local "recent verdict" ledger (§4 `decidedBy`).
 *
 * The production permission pipeline splits in two: the facade decides
 * (`LocalPermissionCheckResult` carries `decidedBy` / `ruleKind` / `mode`),
 * and the v2 turn gate builds the wire mark. The hosted capabilities adapter
 * (`hosted-agent-permission-capabilities.ts`) passes the fields through on
 * the decision itself — that is the primary path. This ledger is only the
 * FALLBACK for a decision source that still strips them: the facade records
 * every final verdict here, and the gate takes (removes) the matching entry
 * right after each check — on the primary path too, so entries never pile
 * up behind a pass-through adapter.
 *
 * Memory is bounded twice: keys are a fixed-size digest (a `write` input
 * carries the whole file body), and the map holds at most
 * `MAX_LEDGER_ENTRIES` (FIFO eviction) for checks no gate ever consumes
 * (non-turn callers of `checkPermission`).
 *
 * Correctness rests on one observed invariant of the host loop: permission
 * checks for one session are strictly sequential (pi's agent loop awaits
 * `prepareToolCall` per tool call even in the parallel batch executor), and
 * the ledger is keyed by `(sessionId, toolName, input)`. Two concurrent
 * entries can therefore only collide on identical keys, and a take-once
 * read removes each entry so nothing is ever re-consumed.
 *
 * This is a correlation aid, not a source of truth: a decision source that
 * passes the fields through explicitly (see `LocalTurnPermissionDecision`)
 * always wins, and a missing entry simply means the wire mark is omitted.
 */

import { createHash } from 'node:crypto';

import type { RuntimePermissionMark } from '@mavis/agent-core/protocol/runtime-event';

/**
 * Attribution fields the facade fills on every check result. `decidedBy` is
 * the check-side subset of the wire union — the `hook` / `user` rows are
 * attributed by the turn gate, never by the facade.
 */
export interface LocalPermissionVerdictAttribution
  extends Pick<RuntimePermissionMark, 'ruleKind' | 'mode'> {
  decidedBy: Extract<RuntimePermissionMark['decidedBy'], 'rule' | 'classifier' | 'mode'>;
}

const MAX_LEDGER_ENTRIES = 64;

const entries = new Map<string, LocalPermissionVerdictAttribution>();

/**
 * Stable structural key for one permission check. Key order is normalized so
 * the facade (which receives a shallow copy of the gate's input snapshot)
 * and the gate (which reads its own snapshot) always agree. Hashed so a
 * large input (a `write` body) never lives in the ledger.
 */
export function localPermissionVerdictKey(
  sessionId: string | undefined,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId ?? '', toolName, stableValue(input)]))
    .digest('base64');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Facade-side write; one entry per completed `checkPermission` call. */
export function recordLocalPermissionVerdict(
  key: string,
  attribution: LocalPermissionVerdictAttribution,
): void {
  if (entries.size >= MAX_LEDGER_ENTRIES && !entries.has(key)) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, attribution);
}

/** Gate-side read; take-once so an entry is never consumed twice. */
export function takeLocalPermissionVerdict(
  key: string,
): LocalPermissionVerdictAttribution | undefined {
  const attribution = entries.get(key);
  if (attribution !== undefined) entries.delete(key);
  return attribution;
}

/** Test isolation. */
export function resetLocalPermissionVerdictLedger(): void {
  entries.clear();
}
