/**
 * Host-intent ports: the product callbacks the bridge's task DEFINITIONS
 * invoke while their phases run. These are the policy boundaries that stay
 * OURS (product supervisors/policies поверх мостом) — the durable phase
 * machine around them is the pi scheduler's.
 *
 * - `runBackground`: the product TaskRunner execution for one background
 *   task (liveness/timeouts stay product policy). The definition awaits the
 *   returned settlement and commits it as the terminal outcome.
 * - `fireCron`: the product cron executor for one job (busy queue,
 *   active-hours policy stay in @mavis/cron). The definition only owns WHEN
 *   (pi sleeping states) and the durable fire bookkeeping.
 *
 * @module
 */

import type { TaskOutputRef, TaskUsage } from '@mavis/background-task';

/** Settlement a background runner reports for its task. */
export interface BackgroundRunSettlement {
	readonly status: 'succeeded' | 'failed';
	readonly reason?: string;
	readonly outputRef?: TaskOutputRef;
	readonly usage?: TaskUsage;
	readonly error?: { readonly message: string; readonly code?: string };
}

/** Context one background run executes under. */
export interface BackgroundRunContext {
	readonly taskId: string;
	readonly kind: string;
	/** True when the run was re-entered after a restart (pi `restarts` > 0). */
	readonly afterRestart: boolean;
	/** The runner should stop observing this signal. */
	readonly signal: AbortSignal;
}

/** Ports bound at {@link ./harness.ts} open time. */
export class OrchestrationHosts {
	private backgroundRun: ((task: BackgroundRunContext, meta: { readonly description?: string }) => Promise<BackgroundRunSettlement>) | undefined;
	private cronFire: ((cronId: string) => Promise<{ readonly note?: string }>) | undefined;
	private cronNextFire: ((cronId: string, nowMs: number) => Promise<number | null> | number | null) | undefined;

	/** Bind the product background runner (composition time). */
	registerBackgroundRunner(run: (task: BackgroundRunContext, meta: { readonly description?: string }) => Promise<BackgroundRunSettlement>): void {
		this.backgroundRun = run;
	}

	/** Bind the product cron executor and next-fire calculator (composition time). */
	registerCronHost(fire: (cronId: string) => Promise<{ readonly note?: string }>, nextFire: (cronId: string, nowMs: number) => Promise<number | null> | number | null): void {
		this.cronFire = fire;
		this.cronNextFire = nextFire;
	}

	/** Runner accessor. Undefined until composition binds it — fail closed. */
	get runBackground(): (task: BackgroundRunContext, meta: { readonly description?: string }) => Promise<BackgroundRunSettlement> {
		if (this.backgroundRun === undefined) {
			throw new Error('no background runner bound: register one via hosts.registerBackgroundRunner()');
		}
		return this.backgroundRun;
	}

	get fireCron(): (cronId: string) => Promise<{ readonly note?: string }> {
		if (this.cronFire === undefined) {
			throw new Error('no cron host bound: register one via hosts.registerCronHost()');
		}
		return this.cronFire;
	}

	get nextCronFire(): (cronId: string, nowMs: number) => Promise<number | null> | number | null {
		if (this.cronNextFire === undefined) {
			throw new Error('no cron host bound: register one via hosts.registerCronHost()');
		}
		return this.cronNextFire;
	}
}
