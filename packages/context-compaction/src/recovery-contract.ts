/**
 * The PUBLIC `context_edit` recovery contract (plan §8 W05: "context_edit
 * recovery-контракт публично"; overflow semantics port-pinned, our omission
 * entry kind).
 *
 * When a model turn fails because the context overflowed, the runner compacts
 * ONCE and retries the turn EXACTLY ONCE (`runWithOverflowRecovery`). A second
 * failure is terminal: the failed attempt's entries (if any reached the log)
 * are hidden behind an append-only `mcode.context_edit` omission entry, and
 * the error propagates. This module pins that contract as a named, importable
 * object so consumers and tests depend on the SAME constants instead of
 * re-deriving them.
 *
 * Invariants (each checkable against {@link CONTEXT_EDIT_RECOVERY_CONTRACT}):
 *
 * 1. **Exactly one recovery compaction and one retry per request episode.**
 *    `maxRecoveryCompactions = 1`, `maxRetries = 1`; a non-overflow error
 *    never triggers either.
 * 2. **Omissions are append-only.** `mcode.context_edit` hides target ids;
 *    the raw records stay in the log, immutable (`transcript records are not
 *    physically deleted`).
 * 3. **No omission for a successful recovery.** A clean retry records nothing.
 * 4. **A failed summary publishes no checkpoint.** A rejected summarizer
 *    response (`SummaryRejectedError`) propagates before any draft exists.
 * 5. **The omission is visible to every projection.** Projection, window
 *    tracker and cut machinery all honor the same target-id set.
 *
 * CONSUMERS / WAVE BOUNDARY (W05 review pass 1): inside this package the
 * invariants are enforced by `runWithOverflowRecovery` and pinned by
 * `overflow-recovery-once.test.ts`, `recovery-contract.test.ts` and the
 * local-runtime-v2 composition test `context-wire.test.ts` (window gate →
 * recovery, final-architecture.md:224). The LIVE request loop — the durable
 * turn driver's overflow path in local-runtime-v2
 * `turn-system/agent-host/driver/` — still runs its own gate/retry logic and
 * does NOT yet call through this contract; wiring it is deliberately NOT
 * W05 (that driver is W04's delivered file area, and provider-level
 * retry/overflow fixes are W06's take per port-plan W06). When that wave
 * lands, the driver should call `runWithOverflowRecovery` with
 * `isContextOverflowError` and this contract's constants instead of local
 * retry counters — until then, "exactly one retry" outside this package is
 * the driver's own property, not this contract's guarantee.
 *
 * @module
 */

import { CONTEXT_EDIT_ENTRY_KIND } from './types.js';

/** The named, frozen recovery contract. */
export const CONTEXT_EDIT_RECOVERY_CONTRACT = Object.freeze({
  /** Entry kind carrying the omission of a failed attempt. */
  entryKind: CONTEXT_EDIT_ENTRY_KIND,
  /** The action discriminator of the omission payload. */
  omissionAction: 'omission',
  /** Recovery compactions per request episode — exactly one. */
  maxRecoveryCompactions: 1,
  /** Retries of the failed attempt per request episode — exactly one. */
  maxRetries: 1,
  /** Raw records targeted by an omission stay in the log, immutable. */
  omissionAppendOnly: true,
  /** A successful retry records no omission. */
  noOmissionOnSuccess: true,
  /** A rejected/failed summary never publishes a checkpoint. */
  noCheckpointOnSummaryFailure: true,
  /** The invariants in prose, for logs/reports/tests to cite. */
  invariants: Object.freeze([
    'exactly one recovery compaction and one retry per request episode',
    'a non-overflow error never triggers recovery',
    'omissions are append-only; raw records are never deleted',
    'a successful retry records no omission',
    'a rejected summary publishes no checkpoint',
  ] as const),
});

export type ContextEditRecoveryContract = typeof CONTEXT_EDIT_RECOVERY_CONTRACT;

/**
 * Runtime shape check of an omission payload against the contract — the form
 * `createOmissionEntryDraft` writes and every projection reads.
 */
export function isContractOmissionPayload(payload: unknown): payload is {
  readonly action: 'omission';
  readonly targetIds: readonly string[];
  readonly reason: string;
  readonly createdAtMs: number;
} {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as { action?: unknown; targetIds?: unknown; reason?: unknown; createdAtMs?: unknown };
  return (
    record.action === CONTEXT_EDIT_RECOVERY_CONTRACT.omissionAction &&
    Array.isArray(record.targetIds) &&
    record.targetIds.every((id) => typeof id === 'string') &&
    typeof record.reason === 'string' &&
    typeof record.createdAtMs === 'number'
  );
}
