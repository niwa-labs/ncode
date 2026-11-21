//
// Release-intent facts (reactive subagents §1.6/§5.3 risk 4, wave 3): the
// durable record that a trusted owner input was accepted for a tool round.
// Idempotent per (conversationId, turnId), point-readable across restarts,
// and never part of the bounded active registry.
//

import { describe, expect, it } from 'vitest';

import {
	DurableSeam,
	releaseIntentEntryId,
	SEAM_ENTRY_KINDS,
} from '../../src/index.js';
import { InMemoryDurableLog } from '../helpers.js';

describe('seam release intent (§1.6, wave 3)', () => {
	it('notes the intent once and replays repeats without a second commit', async () => {
		const seam = await DurableSeam.open(new InMemoryDurableLog());
		const first = await seam.noteReleaseIntent({ conversationId: 'conv', turnId: 'turn-1' });
		expect(first.status).toBe('committed');
		const repeat = await seam.noteReleaseIntent({ conversationId: 'conv', turnId: 'turn-1' });
		expect(repeat.status).toBe('replayed');
		expect(repeat.commitSeq).toBe(first.commitSeq);
		expect(repeat.intentEntryId).toBe(first.intentEntryId);
		// A different round is a different fact.
		const other = await seam.noteReleaseIntent({ conversationId: 'conv', turnId: 'turn-2' });
		expect(other.status).toBe('committed');
		expect(other.intentEntryId).toBe(releaseIntentEntryId('conv', 'turn-2'));
	});

	it('answers hasReleaseIntent by point read, across a restart', async () => {
		const log = new InMemoryDurableLog();
		const seam = await DurableSeam.open(log);
		expect(seam.hasReleaseIntent('conv', 'turn-1')).toBe(false);
		await seam.noteReleaseIntent({ conversationId: 'conv', turnId: 'turn-1' });
		expect(seam.hasReleaseIntent('conv', 'turn-1')).toBe(true);
		expect(seam.hasReleaseIntent('conv', 'turn-x')).toBe(false);

		// The restarted seam answers from the entry index — the same fact the
		// late registration replay consults (setup outliving the in-memory map).
		const restarted = await DurableSeam.open(log);
		expect(restarted.hasReleaseIntent('conv', 'turn-1')).toBe(true);
		const repeat = await restarted.noteReleaseIntent({ conversationId: 'conv', turnId: 'turn-1' });
		expect(repeat.status).toBe('replayed');
	});

	it('keeps the intent out of the bounded active registry', async () => {
		const log = new InMemoryDurableLog();
		const seam = await DurableSeam.open(log);
		await seam.noteReleaseIntent({ conversationId: 'conv', turnId: 'turn-1' });
		const stored = log.batches.flat().find((entry) => entry.kind === SEAM_ENTRY_KINDS.releaseIntent);
		expect(stored).toBeDefined();
		expect(stored?.id).toBe(releaseIntentEntryId('conv', 'turn-1'));
		// Waits and deliveries are the only registry state; the intent never
		// joins them.
		expect(seam.listWaits()).toHaveLength(0);
		expect(seam.listActiveDeliveries()).toHaveLength(0);
	});

	it('refuses empty keys and stores the recorded initiator', async () => {
		const seam = await DurableSeam.open(new InMemoryDurableLog());
		await expect(seam.noteReleaseIntent({ conversationId: '', turnId: 't' })).rejects.toBeDefined();
		await expect(seam.noteReleaseIntent({ conversationId: 'c', turnId: '' })).rejects.toBeDefined();
		await seam.noteReleaseIntent({ conversationId: 'conv', turnId: 'turn-1', initiator: 'steer-service' });
		expect(seam.hasReleaseIntent('conv', 'turn-1')).toBe(true);
	});

	it('reproduces the background outcome of a released tool call for the recovery join', async () => {
		const seam = await DurableSeam.open(new InMemoryDurableLog());
		await seam.openForegroundWait({
			waitId: 'native-wait:conv:turn-1:call-1',
			toolCallId: 'call-1',
			conversationId: 'conv',
			delegationId: 'task-1',
		});
		const prepared = await seam.prepareRelease({
			waitId: 'native-wait:conv:turn-1:call-1',
			expectedVersion: 1,
			reason: 'owner_input',
		});
		await seam.finalizeTool({ toolCallId: 'call-1', outcome: prepared.outcome });
		const outcome = seam.releasedBackgroundOutcomeOfToolCall('call-1');
		expect(outcome?.kind).toBe('background');
		expect(outcome?.reason).toBe('owner_input');
		expect(outcome?.delegationId).toBe('task-1');
		// An unknown outcome (an inline completion) is NOT a release.
		await seam.openForegroundWait({ waitId: 'w2', toolCallId: 'call-2', conversationId: 'conv' });
		await seam.finalizeTool({ toolCallId: 'call-2', outcome: { kind: 'completed', status: 'succeeded' } });
		expect(seam.releasedBackgroundOutcomeOfToolCall('call-2')).toBeUndefined();
		expect(seam.releasedBackgroundOutcomeOfToolCall('call-never')).toBeUndefined();
	});
});
