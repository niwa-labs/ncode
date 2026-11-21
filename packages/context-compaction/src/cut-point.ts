/**
 * Cut-point detection: where the summarized history may end and the kept
 * recent window may begin.
 *
 * Ported invariant from pi v1.3: a cut is allowed ONLY at user, assistant, or
 * custom messages — NEVER at a tool result, which must always follow its tool
 * call. When the walk backwards from the newest entry crosses the
 * `keepRecentTokens` budget, the cut snaps forward to the closest valid cut
 * point, so trailing tool results keep their preceding assistant turn.
 *
 * Also ported from pi v1.3 (W05 review pass 1, settled-tail): the
 * recovery-omission suffix advance — when the tail after the cut is a closed
 * series of omitted recovery attempts with no external replacement and no
 * compaction, the cut advances past it, so the request that preceded the
 * failed attempt is summarized instead of staying visible forever.
 *
 * @module
 */

import { DEFAULT_KEEP_RECENT_TOKENS, estimateMessageTokens } from './estimate.js';
import type { CompactionMessage, CutPointResult, ProjectedEntry } from './types.js';

/**
 * Whether a cut may land directly at this message. Tool results are
 * categorically excluded; everything conversation-visible is allowed.
 */
export function isCutPointMessage(message: CompactionMessage): boolean {
  switch (message.role) {
    case 'user':
    case 'assistant':
    case 'custom':
      return true;
    case 'toolResult':
      return false;
  }
}

/**
 * Whether this message starts a new user turn. Assistant messages and tool
 * results continue the current turn; compaction summaries (projected as user
 * messages) are turn starts too — the caller excludes compaction entries
 * before consulting this.
 */
export function isTurnStartMessage(message: CompactionMessage): boolean {
  switch (message.role) {
    case 'user':
    case 'custom':
      return true;
    case 'assistant':
    case 'toolResult':
      return false;
  }
}

function entryHasCutPoint(entry: ProjectedEntry): boolean {
  return !entry.isCompaction && entry.contextMessages.some(isCutPointMessage);
}

function isTurnStartEntry(entry: ProjectedEntry): boolean {
  return !entry.isCompaction && entry.contextMessages.some(isTurnStartMessage);
}

/**
 * Index of the user-like entry that starts the turn containing `entryIndex`,
 * or `-1` when none exists at or after `startIndex`.
 */
export function findTurnStartIndex(entries: readonly ProjectedEntry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i -= 1) {
    if (isTurnStartEntry(entries[i]!)) return i;
  }
  return -1;
}

/**
 * Find the cut point that keeps approximately `keepRecentTokens` of the
 * newest context.
 *
 * Algorithm (pi semantics): walk backwards from the newest entry accumulating
 * estimated tokens; stop at the first entry that crosses the budget and cut
 * at the closest valid cut point at or after it. If no entry crosses the
 * budget, the cut falls back to the FIRST valid cut point (headers and other
 * zero-message entries before it get summarized away, which is harmless).
 *
 * When the budget WAS crossed and the tail after the cut is a closed
 * recovery-omission suffix (an omitted assistant attempt, no external
 * replacement, no compaction — pin compaction.ts:818-843), the cut advances
 * one entry past it, exactly like pi's `findProjectedCutPoint`: the named
 * first kept entry may then be the omitted attempt itself.
 *
 * Returns the index of the first kept entry, whether the cut splits a turn,
 * and where that turn started.
 */
export function findCutPoint(
  entries: readonly ProjectedEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number = DEFAULT_KEEP_RECENT_TOKENS,
): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    if (entryHasCutPoint(entries[i]!)) cutPoints.push(i);
  }
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let exceededBudget = false;
  let cutIndex = cutPoints[0]!;
  for (let i = endIndex - 1; i >= startIndex; i -= 1) {
    const entry = entries[i]!;
    const entryTokens = entry.contextMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (entryTokens === 0) continue;
    accumulatedTokens += entryTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      // Snap forward to the closest valid cut point: trailing tool results may
      // overflow the budget by themselves — then their assistant tool call is
      // kept rather than falling back to the first message.
      exceededBudget = true;
      cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1]!;
      break;
    }
  }

  // Recovery-omission suffix advance (pin coding-agent compaction.ts:818-843,
  // W05 review pass 1 settled-tail): a recovery attempt and its omission
  // edits are context-invisible after the last visible input. Advance only
  // for a CLOSED suffix containing an omitted assistant attempt; arbitrary
  // metadata must not move the cut past unsent input.
  const suffix = entries.slice(cutIndex + 1, endIndex);
  const isOmitted = (entry: ProjectedEntry): boolean =>
    entry.intrinsicallyVisible && entry.contextMessages.length === 0;
  // pi's `hasExternalReplacement` guard (a context_edit carrying a non-null
  // replacement for a target outside the omitted suffix) is structurally
  // false over our kinds: the declared mcode spelling is PURE omission
  // (`{action:'omission', targetIds}`, mapped to pi `replacement: null`
  // edits), and this projection recognizes no replacement variant.
  const isRecoveryOmissionSuffix =
    exceededBudget &&
    suffix.some((entry) => entry.sourceRole === 'assistant' && isOmitted(entry)) &&
    suffix.every((entry) => !entry.isCompaction && (!entry.intrinsicallyVisible || isOmitted(entry)));
  if (isRecoveryOmissionSuffix) cutIndex += 1;

  // The durable checkpoint names `firstKeptEntryId`, and both projection
  // folds resolve it: omitted entries stay RESOLVABLE members (this package's
  // `projectContext` resolves raw ids; `@mavis/context-projection` keeps the
  // slot of an omitted member), while audit/control entries never become
  // members — an id only those could produce can never be applied and the
  // session would wedge at that seq. Without the suffix advance above that
  // guarantee held by construction (`cutIndex` was always a `cutPoints`
  // member, every member visible); WITH it — exactly as in pi — the named
  // entry may instead be the omitted recovery attempt itself: a live member
  // the checkpoint deliberately names while its content is hidden, so the
  // whole invisible tail collapses into the next summary. The suffix
  // condition guarantees the advance lands on either that omitted member or
  // pure bookkeeping, never on a checkpoint and never past unsent input.

  const startsTurn = isTurnStartEntry(entries[cutIndex]!);
  const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}
