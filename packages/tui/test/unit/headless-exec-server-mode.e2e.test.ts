/**
 * W5 e2e (arch §4.8, exec row): `mcode exec` as a THIN CLIENT of the daemon
 * while a live durable writer owns the runtime — the product chain, composed
 * for real:
 *
 *   runTuiExecCommand → runTuiExec (the REAL runner + coordinator) →
 *   TuiRuntimeAdapter → TuiRemoteCliService (real port adapter) →
 *   real McodedClient → real McodedDaemon on a real unix socket → CliBridge
 *   → the daemon-side CliService double (the ONLY runtime owner here).
 *
 * The scenario the review named: the daemon already OWNS the runtime/durable
 * log (a live writer). An exec that spun its in-process runtime up would
 * fight it (`DurableHistoryLogOwnedError`, §4.6.2 п.5) — in server mode it
 * must NOT: the turn runs THROUGH the daemon, the exec process hosts no
 * runtime at all, and §4.8's contract holds:
 * - `createSession` → `stream.open sendMessage` → печать → обычный выход
 *   после wire `[DONE]` (exit 0, the daemon's answer printed);
 * - Ctrl+C mid-turn → a REMOTE abort (the daemon-side runtime receives
 *   `abortSession` — W0 F3's only remote turn-cancel), exit code 130;
 * - codes are the off-path codes (§4.8: "коды выхода не меняются").
 *
 * Only the embedded-host composition is cut out by injection — exactly the
 * swap the `auto` branch of `createTuiRuntime` makes
 * (`createRemoteRuntimeHost`; pinned by runtime-lifecycle-server-mode.test).
 * Everything above and below it is product code.
 *
 * @module
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	CliBridge,
	EchoRuntimeAdapter,
	MCODED_TOKEN_BASENAME,
	McodedClient,
	McodedDaemon,
	PushableIterable,
} from '@mavis/mcoded';

import { runTuiExecCommand } from '../../src/cli/run-exec-command.js';
import { MINIMAX_CODE_EXEC_EXIT_CODES } from '../../src/headless/exit-policy.js';
import { runTuiExec } from '../../src/headless/runner.js';
import { TuiRuntimeAdapter } from '../../src/runtime/adapter.js';
import { composeTuiRemoteCliService } from '../../src/runtime/remote-host.js';

/** SSE-style turn frames the daemon-side runtime streams (TUI projection input). */
const TURN_FRAMES = [
	JSON.stringify({
		type: 2,
		agent_message: { id: 'assistant-1', role: 'assistant', content: 'daemon says hi' },
	}),
	JSON.stringify({ type: 'session_status', session_status: { type: 'finished' } }),
	'[DONE]',
];

interface RecordedCall {
	readonly method: string;
	readonly args: unknown[];
}

/**
 * The daemon-side CliService double: the ONLY runtime owner of the scenario
 * (the live durable writer). `sendMessage` streams the turn frames; with
 * `hold` set, it holds the stream open until the remote `abortSession`
 * lands — mirroring a real runtime whose turn is in flight.
 */
function daemonRuntimeDouble() {
	const calls: RecordedCall[] = [];
	let hold = false;
	let release: ((error: Error) => void) | undefined;
	const cli = {
		// Wire shape (the daemon returns the raw CliService view; the TUI port
		// normalizes `{auth, provider, selection}`): a logged-in BYOK account.
		getAccountStatus: async () => ({
			auth: { tokenPresent: true },
			provider: { id: 'default-provider', authMode: 'byok' },
			selection: { providerId: 'default-provider' },
			warnings: [],
		}),
		listModels: async () => [
			{ providerId: 'default-provider', modelId: 'default-model', variant: 'balanced', selected: true },
		],
		createSession: async (...args: unknown[]) => {
			calls.push({ method: 'createSession', args });
			return { sessionId: 'sess-exec-1', workspaceDir: '/tmp/w5-exec' };
		},
		getSession: async (req: { id?: string }) => ({
			sessionId: req.id ?? 'sess-exec-1',
			workspaceDir: '/tmp/w5-exec',
			archived: false,
		}),
		// Wire shape: `{request?: …}` — the adapter reads `response.request`.
		getPendingQuestionnaire: async () => ({}),
		listPendingPermissions: async () => ({ requests: [] }),
		getSessionUsage: async () => ({ rows: [] }),
		sendMessage: async (...args: unknown[]) => {
			calls.push({ method: 'sendMessage', args });
			const source = (async function* () {
				for (const data of TURN_FRAMES) {
					if (hold) {
						await new Promise<never>((_, reject) => {
							release = reject;
						});
					}
					yield { dataJson: data };
				}
			})();
			return { ok: true as const, source };
		},
		abortSession: async (...args: unknown[]) => {
			calls.push({ method: 'abortSession', args });
			return true;
		},
		isGoalEnabled: () => false,
		getSessionPublishStaleSessions: (): readonly string[] => [],
	};
	return {
		cli,
		calls,
		set holdTurn(value: boolean) {
			hold = value;
		},
		releaseTurn: (): void => {
			release?.(new Error('turn released: the remote abort landed'));
		},
		waitForMethod: async (method: string): Promise<RecordedCall> => {
			const deadline = Date.now() + 5_000;
			for (;;) {
				const found = calls.find((call) => call.method === method);
				if (found) return found;
				if (Date.now() > deadline) {
					throw new Error(`the daemon never saw ${method}; got: ${calls.map((c) => c.method).join(', ')}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
	};
}

/** Fake exec process: records signal listeners so the test fires Ctrl+C. */
function fakeProcess() {
	const listeners = new Map<string, () => void>();
	return {
		listeners,
		exitCode: undefined as number | string | undefined,
		once(signal: string, listener: () => void) {
			listeners.set(signal, listener);
			return this;
		},
		off(signal: string) {
			listeners.delete(signal);
			return this;
		},
		fire(signal: string): void {
			listeners.get(signal)?.();
		},
	};
}

async function startDaemon(
	root: string,
	cli: unknown,
	events: PushableIterable<unknown>,
): Promise<McodedDaemon> {
	writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
	const daemon = new McodedDaemon({
		root,
		adapter: new EchoRuntimeAdapter(),
		durableLayout: false,
		listenFd: null,
		handshake: { token: 'test-token', dataDir: root },
		hub: {
			bridge: new CliBridge({ cliService: () => cli as never }),
			globalEvents: events,
		},
	});
	await daemon.start();
	return daemon;
}

interface ExecHarness {
	readonly root: string;
	readonly printed: string[];
	readonly errors: string[];
	readonly double: ReturnType<typeof daemonRuntimeDouble>;
	readonly daemon: McodedDaemon;
	readonly cliService: ReturnType<typeof composeTuiRemoteCliService>['cliService'];
	close(): void;
}

async function startExecHarness(prefix: string): Promise<ExecHarness> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	const double = daemonRuntimeDouble();
	const daemon = await startDaemon(root, double.cli, new PushableIterable<unknown>());
	const client = new McodedClient({
		socketPath: daemon.socketPath,
		handshake: { token: 'test-token', dataDir: root, clientInstanceId: `exec-${prefix}` },
		readyTimeoutMs: 10_000,
	});
	await client.connect();
	const { cliService } = composeTuiRemoteCliService(client);
	return {
		root,
		printed: [],
		errors: [],
		double,
		daemon,
		cliService,
		close: () => client.close(),
	};
}

function runExec(harness: ExecHarness, processRef: ReturnType<typeof fakeProcess>) {
	return runTuiExecCommand('prompt through the daemon', { outputFormat: 'text' }, 'test-version', {
		processRef: processRef as never,
		resolveDataDir: async () => harness.root,
		writeError: (value: string) => {
			harness.errors.push(value);
		},
		createRuntime: (async (options: { workspaceDir?: string }) => ({
			adapter: new TuiRuntimeAdapter(harness.cliService as never, {
				workspaceDir: options.workspaceDir,
			}),
		})) as never,
		shutdownRuntime: (async () => {
			harness.close();
		}) as never,
		runExec: ((input: unknown, run: {
			runtime: unknown;
			signal: AbortSignal;
			shutdown: () => Promise<void>;
		}) =>
			runTuiExec(input as never, {
				runtime: run.runtime as never,
				signal: run.signal,
				shutdown: run.shutdown,
				stdout: (value: string) => {
					harness.printed.push(value);
				},
				stderr: (value: string) => {
					harness.errors.push(value);
				},
			} as never)) as never,
	});
}

describe('W5 exec e2e: the run goes through the daemon while a durable writer is live (§4.8)', () => {
	let harness: ExecHarness | undefined;

	afterEach(async () => {
		harness?.double.releaseTurn();
		if (harness) await harness.daemon.shutdown();
		harness = undefined;
	});

	it('prints the daemon answer and exits 0 after the wire [DONE]; the exec hosts no runtime', { timeout: 30_000 }, async () => {
		harness = await startExecHarness('w5-exec-');
		const proc = fakeProcess();
		await runExec(harness, proc);

		// §4.8: the turn ran ON the daemon (createSession + sendMessage crossed
		// the wire to the live writer) — the exec process is a thin client.
		const methods = harness.double.calls.map((call) => call.method);
		expect(methods).toContain('createSession');
		expect(methods).toContain('sendMessage');
		expect(methods).not.toContain('abortSession');
		// Печать: the daemon-side assistant message reached stdout.
		expect(harness.printed.join('')).toContain('daemon says hi');
		// Обычный выход после [DONE] — exit 0, the off-path code.
		expect(proc.exitCode).toBe(MINIMAX_CODE_EXEC_EXIT_CODES.success);
	});

	it('Ctrl+C mid-turn aborts REMOTELY (the daemon records abortSession) and exits 130', { timeout: 30_000 }, async () => {
		harness = await startExecHarness('w5-exec-abort-');
		harness.double.holdTurn = true; // the turn hangs in flight daemon-side
		const proc = fakeProcess();
		const run = runExec(harness, proc);
		await harness.double.waitForMethod('sendMessage');
		proc.fire('SIGINT');
		await run;

		// W0 F3 on the remote path: the abort is EXPLICIT — the daemon-side
		// runtime received `abortSession` (the stream.cancel{abort} endpoint).
		const abort = await harness.double.waitForMethod('abortSession');
		expect((abort.args[0] as { id?: string }).id).toBe('sess-exec-1');
		// Коды выхода не меняются: cancelled is 130, exactly the off path.
		expect(proc.exitCode).toBe(MINIMAX_CODE_EXEC_EXIT_CODES.cancelled);
	});
});
