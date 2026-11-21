/**
 * Delegation roster document helpers (W08 part A; the "roster" member of the
 * goal/plan/todo/memory/roster documents row, port-plan.md:508).
 *
 * The delegation SUPERVISOR (`@mavis/delegation-supervisor`) remains the
 * canonical writer of its own entry stream; this module gives the roster its
 * documents home — a rewindable conversation document with as-of forks — and
 * is the ONLY writer of that document kind. `replaceRoster` must be called
 * from the supervisor's adapter (one commit per roster update); readers get
 * current and as-of views.
 *
 * @module
 */

import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable';

import { RosterDocs, type RosterMember, type RosterValue } from './documents.js';
import type { OrchestrationHarness } from './harness.js';

export const ROSTER_KEY = 'delegations';

/** Replace the whole roster in ONE commit (the supervisor adapter's writer). */
export async function replaceRoster(
	harness: OrchestrationHarness,
	conversationId: ConversationId,
	members: readonly RosterMember[],
): Promise<void> {
	await harness.commit(async (tx: Tx) => {
		const draft = await tx.doc(RosterDocs, conversationId, ROSTER_KEY, { members: [] });
		draft.members = [...members] as RosterValue['members'];
	});
}

/** Current roster of a conversation. */
export async function rosterOf(harness: OrchestrationHarness, conversationId: ConversationId): Promise<readonly RosterMember[]> {
	return harness.commit(async (tx) => {
		const draft = await tx.doc(RosterDocs, conversationId, ROSTER_KEY, { members: [] });
		return draft.members.map((member) => ({ ...member }));
	});
}

/** As-of roster: the roster as it was at visible entry `at` (rewind/fork reads). */
export async function rosterAsOf(harness: OrchestrationHarness, conversationId: ConversationId, at: EntryId): Promise<readonly RosterMember[]> {
	const snapshot = await harness.pi.snapshotAsOf(RosterDocs, conversationId, ROSTER_KEY, at, harness.context);
	return snapshot?.members ?? [];
}
