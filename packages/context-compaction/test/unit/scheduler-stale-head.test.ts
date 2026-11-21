// V-K07 (scheduler half): a background compaction job that raced appends
// must never cut entries appended while its summarizer ran.
//
// The checkpoint names `firstKeptEntryId` — a PREFIX boundary of the
// append-only log. Entries appended after the summarizer sampled the log are
// appended at the TAIL, i.e. after the boundary, so the projection keeps
// them: the stale summary summarizes the past, it cannot swallow the future.
// This pins the no-data-loss half of the wave's readiness criterion ("ни
// один stale summary не затёр новые entries/effects").
//
// The OTHER half — an expected-head guard before the checkpoint append (pi
// durable's CAS on the live doc; plan W05 "expected-head atomic commit") —
// is the algorithm owner's zone; the hazard is documented there: a second
// compaction that cuts the named target BEFORE the stale job appends would
// make the projection fold reject the stale checkpoint (firstKeptEntryId no
// longer a window member), so the append seam must re-validate the head.

import { describe, expect, it } from 'vitest';

import { createBackgroundCompactionScheduler, projectContext } from '../../src/index.js';
import type { DurableEntryDraft, LogEntry, SchedulerSession } from '../../src/index.js';
import { MemoryLog, assistantMessage, filler, messageEntry, stamp, userMessage } from './helpers.js';

describe('background job racing tail appends (V-K07 no-loss half)', () => {
	it('entries appended during the summarizer call survive the checkpoint append', async () => {
		const log = new MemoryLog();
		await log.append([
			messageEntry(userMessage(`first turn ${filler(16_000)}`)),
			messageEntry(assistantMessage('first answer')),
			messageEntry(userMessage(`second turn ${filler(16_000)}`)),
			messageEntry(assistantMessage('second answer')),
			messageEntry(userMessage('third turn')),
		]);

		let appendedDuringSummarizer: DurableEntryDraft[] | null = null;
		const session: SchedulerSession = {
			get entries() {
				return log.entries;
			},
			append: (drafts) => log.append(drafts),
		};

		const scheduler = createBackgroundCompactionScheduler({
			budgets: { tokenBudget: 1_000 },
			session,
			summarizer: async () => {
				// The turn loop keeps working while the summarizer runs: a new
				// user turn lands in the log AFTER the job sampled it.
				appendedDuringSummarizer = [
					messageEntry(userMessage('late breaking input')),
					messageEntry(assistantMessage('late answer')),
				];
				await log.append(appendedDuringSummarizer);
				return 'STALE-BUT-VALID SUMMARY';
			},
			keepRecentTokens: 1_000,
		});

		const notification = scheduler.notify();
		expect(notification.level).toBe('blocking');
		const outcome = await notification.job;
		expect(outcome).not.toBeNull();

		// The checkpoint was appended after the racing entries...
		const checkpointIndex = log.entries.findIndex(
			(entry) => entry.id === outcome!.entryId,
		);
		const lateInputIndex = log.entries.findIndex(
			(entry) => (entry.payload as { content?: unknown }).content === 'late breaking input',
		);
		expect(lateInputIndex).toBeGreaterThan(-1);
		expect(checkpointIndex).toBeGreaterThan(lateInputIndex);

		// ...and the projected window KEEPS them: the summary cut only the
		// prefix that existed when the job sampled the log.
		const projected = projectContext(log.entries);
		const serialized = projected.messages.map((message) =>
			message.role === 'user' && typeof message.content === 'string' ? message.content : null,
		);
		expect(serialized).toContain('late breaking input');
		expect(projected.entries[lateInputIndex]!.contextMessages).toHaveLength(1);

		// The checkpoint itself resolves: its firstKeptEntryId is a live window
		// member (the fold accepts it — no projection poison from the race).
		const keptIndex = log.entries.findIndex((entry) => entry.id === outcome!.firstKeptEntryId);
		expect(keptIndex).toBeLessThanOrEqual(lateInputIndex);
		expect(projected.entries[keptIndex]!.contextMessages).toHaveLength(1);
	});

	it('an omitted overflow attempt is invisible to the window but its entry stays in the log', async () => {
		const failedAttempt = messageEntry(assistantMessage('failed attempt'));
		const entries: LogEntry[] = [
			messageEntry(userMessage('the request')),
			failedAttempt,
			stamp(
				{ id: 'om-1', kind: 'mcode.context_edit', payload: { action: 'omission', targetIds: [failedAttempt.id], reason: 'overflow', createdAtMs: 0 } },
				3,
				0,
			),
			messageEntry(userMessage('retry input')),
		];
		const projected = projectContext(entries);
		// The failed attempt never reaches the model; the retry does. The
		// projection fold side keeps the same invariant (checkpoint-cross-package).
		expect(projected.entries[1]!.contextMessages).toHaveLength(0);
		expect(projected.messages.map((message) => (message as { content?: unknown }).content)).toEqual(['the request', 'retry input']);
	});
});
