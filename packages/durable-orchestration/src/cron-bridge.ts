/**
 * Cron wakeups as pi sleeping tasks (W08 part A; the §2.4.6 A6 fate —
 * "отдельный competing cron/task scheduler не запускается", port-plan.md:196):
 * the due-time of every cron job is a pi `sleeping` task state on the ONE
 * scheduler. @mavis/cron keeps the product UX (config files, busy queue,
 * active-hours policy, report delivery) through the {@link OrchestrationHosts}
 * ports; the bridge owns only the durable WHEN and the fire bookkeeping.
 *
 * A missed fire (daemon down at the deadline) wakes immediately on the next
 * open — the host's fire policy decides admission (active hours, busy queue),
 * so recovery can never bypass product policy.
 *
 * @module
 */

import { defineTask } from '@earendil-works/pi-durable';
import type { TaskId } from '@earendil-works/pi-durable';

import { createLogger } from '@mavis/logging';

import { CronIndexDoc, CronRecordDocs, type CronIndexValue, type CronStateValue } from './documents.js';
import { BridgeContractMismatchError, UnknownOrchestratedTaskError } from './errors.js';
import type { OrchestrationHarness } from './harness.js';
import type { OrchestrationHosts } from './host-intents.js';

const log = createLogger('mcode:orchestration');

/** Registered pi task kind of the cron wake bridge. */
export const CRON_WAKE_KIND = 'mcode.cron.wake.v1';

/** Definition input (durable). */
export interface CronWakeInput {
	readonly cronId: string;
	readonly configDigest: string;
}

/** Definition checkpoint. */
export type CronWakeCheckpoint = { readonly phase: 'wait' | 'fire' };

/** Result payload (durable): the last computed next fire. */
export type CronWakeResult = { readonly nextFireMs: number | null };

type CronOutcome =
	| { readonly status: 'completed'; readonly result: CronWakeResult }
	| { readonly status: 'failed'; readonly error: { readonly message: string } }
	| { readonly status: 'aborted'; readonly reason?: string };

/** Build the wake definition bound to the host-intent ports. */
export function cronWakeDefinition(hosts: OrchestrationHosts) {
	return defineTask<CronWakeInput, CronWakeCheckpoint, CronWakeResult, object>({
		name: CRON_WAKE_KIND,
		version: 1,
		initial: () => ({ phase: 'wait' }),
		phases: {
			// Compute the next due time from the product cron policy (off the
			// session line) and commit the durable sleep — ONE write, the only
			// timer this job has.
			wait: async (task, runtime, context) => {
				const next = await hosts.nextCronFire(task.input.cronId, runtime.now());
				if (next === null) {
					await runtime.commit(
						() =>
							({ status: 'terminal', outcome: { status: 'completed', result: { nextFireMs: null } } }) satisfies {
								status: 'terminal';
								outcome: CronOutcome;
							},
						context,
					);
					return;
				}
				await runtime.commit(
					() => ({ status: 'sleeping', until: next, checkpoint: { phase: 'fire' } }) satisfies {
						status: 'sleeping';
						until: number;
						checkpoint: CronWakeCheckpoint;
					},
					context,
				);
			},
			// Due: fire through the product executor (busy queue/active hours are
			// its policy), record the durable fire fact, then go recompute.
			fire: async (task, runtime, context) => {
				const note = await hosts.fireCron(task.input.cronId);
				const at = runtime.now();
				await runtime.commit(async (tx) => {
					// The durable fire fact lives in the SESSION-scoped record
					// (keyed by cronId), so it stays readable after retirement.
					const record = await tx.doc(CronRecordDocs, task.input.cronId, {
						cronId: task.input.cronId,
						configDigest: task.input.configDigest,
						lastFiredMs: null,
						nextFireMs: null,
						fireCount: 0,
					});
					record.lastFiredMs = at;
					record.fireCount = record.fireCount + 1;
					if (note?.note !== undefined) record.lastFireNote = note.note;
					return { status: 'sleeping', until: at, checkpoint: { phase: 'wait' } };
				}, context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'cron_retired' } }) satisfies {
					status: 'terminal';
					outcome: CronOutcome;
				},
				context,
			);
		},
	});
}

/** Registry entry for the wake definition (bound at harness open). */
export function cronWakeExtension(hosts: OrchestrationHosts): { readonly name: string; readonly tasks: readonly [ReturnType<typeof cronWakeDefinition>] } {
	const definition = cronWakeDefinition(hosts);
	return { name: 'mcode.orchestration.cron', tasks: [definition] };
}

// ---------------------------------------------------------------------------
// Product-facing bridge
// ---------------------------------------------------------------------------

export interface CronJobBridgeOptions {
	readonly harness: OrchestrationHarness;
	readonly hosts: OrchestrationHosts;
}

/** Product handle: one durable wake task per cron job, on the one scheduler. */
export class CronJobBridge {
	readonly #harness: OrchestrationHarness;
	readonly #definition: ReturnType<typeof cronWakeDefinition>;

	constructor(options: CronJobBridgeOptions) {
		this.#harness = options.harness;
		this.#definition = cronWakeDefinition(options.hosts);
	}

	/**
	 * Ensure the wake task of `cronId` exists and matches `configDigest`. A
	 * digest change retires the old wake task (pi abort) and schedules a new
	 * one; everything happens on the one scheduler.
	 */
	async ensure(cronId: string, configDigest: string): Promise<{ piTaskId: number; created: boolean }> {
		const index = await this.#readIndex();
		const existing = index.jobs[cronId];
		if (existing !== undefined && existing.configDigest === configDigest) {
			const record = await this.#harness.task(existing.piTaskId as TaskId);
			if (record !== undefined && record.state.status !== 'terminal') {
				return { piTaskId: existing.piTaskId, created: false };
			}
		}
		if (existing !== undefined) {
			await this.#harness.abortTask(existing.piTaskId as TaskId);
		}
		const piTaskId = await this.#harness.commit(async (tx) => {
			const indexDraft = await tx.doc(CronIndexDoc);
			indexDraft.jobs[cronId] = { piTaskId: existing?.piTaskId ?? -1, configDigest };
			const minted = await tx.createTask(
				this.#definition,
				{ cronId, configDigest },
				{ ownership: { kind: 'conversation' }, conversationId: await this.#harness.root(), background: true },
			);
			await tx.doc(CronRecordDocs, cronId, {
				cronId,
				configDigest,
				lastFiredMs: null,
				nextFireMs: null,
				fireCount: 0,
			} satisfies CronStateValue);
			indexDraft.jobs[cronId] = { piTaskId: minted, configDigest };
			return minted;
		});
		log.debug('cron wake task scheduled', { cronId, piTaskId: String(piTaskId) });
		return { piTaskId, created: true };
	}

	/** Retire a job's wake task (idempotent; unknown cronId is a no-op). */
	async retire(cronId: string): Promise<void> {
		const index = await this.#harness.pi.snapshot(CronIndexDoc, this.#harness.context);
		const existing = index?.jobs[cronId];
		if (existing === undefined) return;
		await this.#harness.abortTask(existing.piTaskId as TaskId);
	}

	/** Durable state of one job's wake task. */
	async state(cronId: string): Promise<{ piTaskId: number; state: CronStateValue; wakeStatus: string } | undefined> {
		const index = await this.#readIndex();
		const existing = index.jobs[cronId];
		if (existing === undefined) return undefined;
		const record = await this.#harness.task(existing.piTaskId as TaskId);
		if (record === undefined) throw new UnknownOrchestratedTaskError(String(existing.piTaskId));
		const state = await this.#harness.commit(async (tx) => {
			const draft = await tx.doc(CronRecordDocs, cronId, {
				cronId,
				configDigest: existing.configDigest,
				lastFiredMs: null,
				nextFireMs: null,
				fireCount: 0,
			});
			return { ...draft } as CronStateValue;
		});
		return { piTaskId: existing.piTaskId, state, wakeStatus: record.state.status };
	}

	async #readIndex(): Promise<CronIndexValue> {
		return this.#harness.commit(async (tx) => {
			const draft = await tx.doc(CronIndexDoc);
			return { jobs: JSON.parse(JSON.stringify(draft.jobs)) as CronIndexValue['jobs'] };
		});
	}
}
