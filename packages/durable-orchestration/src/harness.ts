/**
 * The ONE durable scheduler: the pinned pi-durable `Harness` opened over OUR
 * `Storage` (production: `@mavis/durable-backend-sqlite-zstd`
 * `PiSqliteZstdStorage`; tests: `MemoryStorage`).
 *
 * Fate application (merge map §4, port-plan.md:497,508; §2.4.6 A6 invariants,
 * port-plan.md:195): task phases have exactly one owner — the pi
 * `TaskScheduler` inside this harness. Product supervisors/policies (goal UX,
 * the background-task manager, cron config, the delegation supervisor) remain
 * adapters ON TOP: they write intents (documents) and read durable states;
 * they never run a second scheduler, second timer wheel, or a second
 * persistence path for orchestration state.
 *
 * Everything product code addresses goes through the session/document/task
 * surfaces of this module; nothing imports harness internals.
 *
 * @module
 */

import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import {
	createRegistry,
	Harness,
	type ConversationId,
	type Extension,
	type HarnessOptions,
	type Registry,
	type Storage,
	type TaskId,
	type TaskRecord,
	type Tx,
} from '@earendil-works/pi-durable';
import { createModels, type Models } from '@earendil-works/pi-ai';

import { createLogger } from '@mavis/logging';

import { backgroundTaskExtension } from './background-store.js';
import { cronWakeExtension } from './cron-bridge.js';
import { OrchestrationHosts } from './host-intents.js';

const log = createLogger('mcode:orchestration');

/** Host-supplied scheduler plumbing. All optional; defaults keep tests simple. */
export interface OrchestrationHarnessOptions {
	/** The pi `Storage` the ONE scheduler runs over (our adapter in production). */
	readonly storage: Storage;
	/** Host clock (epoch ms). Sleeping tasks store deadlines on it — every process opening the storage must share one clock. */
	readonly now?: () => number;
	/** Host timers (`setTimeout` default); tests pass a manual clock. */
	readonly setTimer?: (callback: () => void, delayMs: number, options: { readonly background: boolean }) => (() => void) | undefined;
	/**
	 * Wake integration (daemon alarm) instead of in-process timers; the host
	 * calls `resume()` when its wakeup fires. Without it the scheduler arms
	 * its own timers.
	 */
	readonly onWake?: (wake: { readonly active: boolean; readonly at?: number }) => void;
	/** Failure containment for scheduler/task faults (surfaced, never swallowed). */
	readonly onReport?: (error: unknown, info: { readonly type: string }) => void;
	/**
	 * Model access for the harness's BUILT-IN tasks (generation/compaction).
	 * Product composition injects the W06 model runtime; the default stub has
	 * no models, so a built-in generation task would fail fast ("model not
	 * found") rather than silently run — fail-closed by construction.
	 */
	readonly models?: Models;
	readonly settings?: HarnessOptions['settings'];
}

/** The orchestration harness handle product adapters hold. */
export interface OrchestrationHarness {
	/** The pinned pi harness (the ONE scheduler). */
	readonly pi: Harness;
	readonly registry: Registry;
	/** Host-intent ports the task definitions invoke (runner/fire callbacks). */
	readonly hosts: OrchestrationHosts;
	/** The context this harness was opened with (reads/writes default to it). */
	readonly context: Context;
	/** Run one atomic transaction on the session line. */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context?: Context): Promise<T>;
	/** Create (or return) the root conversation; the bridge's default task owner. */
	root(context?: Context): Promise<ConversationId>;
	/** Durable task record read. */
	task(id: TaskId, context?: Context): Promise<TaskRecord<import('@earendil-works/chord/json').JsonValue, import('@earendil-works/chord/json').JsonValue, unknown> | undefined>;
	/** Abort a task (pi abort mark; the definition's abort handler settles it). */
	abortTask(id: TaskId, context?: Context): Promise<'marked' | 'terminal'>;
	/** Resume scheduling after a host wake (sleeping tasks re-evaluated). */
	resume(): void;
	/** Close the harness (seals admission, settles, closes storage). */
	close(context?: Context): Promise<void>;
}

/**
 * Open the orchestration harness: registry with built-ins + the product
 * orchestration extension, then `Harness.open`. `openTasks` reconciles
 * surviving `running` records (crash recovery) before this resolves — the
 * daemon-death recovery path starts here.
 */
export async function openOrchestrationHarness(options: OrchestrationHarnessOptions, context: Context = BACKGROUND_CONTEXT): Promise<OrchestrationHarness> {
	const registry: Registry = createRegistry();
	const hosts = new OrchestrationHosts();
	registry.install(orchestrationExtension(hosts));
	const harness = await Harness.open(options.storage, {
		registry,
		identity: { attribution: null },
		models: options.models ?? NO_MODELS,
		...(options.settings ? { settings: options.settings } : {}),
		...(options.now !== undefined ? { now: options.now } : {}),
		...(options.setTimer !== undefined ? { setTimer: options.setTimer } : {}),
		...(options.onWake !== undefined ? { onWake: options.onWake } : {}),
		onReport: (report) => {
			const { error, kind: type } = report;
			log.error('orchestration harness reported a fault', { reportType: type, error: error instanceof Error ? error.message : String(error) });
			options.onReport?.(error, { type });
		},
	}, context);
	log.info('orchestration harness opened');
	// The orchestration host is daemon-style: the ONE scheduler runs from open
	// (pi arms its own wake timers; a host alarm can take over via onWake).
	harness.resume();
	const rootPromise = harness.root(context).then((c) => c.id);
	return {
		pi: harness,
		registry,
		hosts,
		context,
		commit: (change, ctx = context) => harness.commit(change, ctx),
		root: async (ctx = context) => await rootPromise,
		task: (id, ctx = context) => harness.getTask(id, ctx),
		abortTask: (id, ctx = context) => harness.abortTask(id, ctx),
		resume: () => harness.resume(),
		close: (ctx = context) => harness.close(ctx),
	};
}

/**
 * The product orchestration extension: the background-task ledger and the
 * cron wake bridge as one registry entry. Task definitions live in their
 * modules.
 */
function orchestrationExtension(hosts: OrchestrationHosts): Extension {
	return {
		name: 'mcode.orchestration',
		tasks: [...backgroundTaskExtension().tasks, ...cronWakeExtension(hosts).tasks],
	};
}

/**
 * Fail-closed model stub: the harness's built-in generation/compaction tasks
 * have no models here. Product composition injects the real W06 runtime; a
 * caller that somehow starts a built-in generation gets a lookup failure, not
 * a silent success.
 */
// An actual empty Pi registry preserves fail-closed lookup while implementing
// the complete Models contract (identity/auth/deferred methods included).
const NO_MODELS: Models = createModels({ identity: { attribution: null } });
