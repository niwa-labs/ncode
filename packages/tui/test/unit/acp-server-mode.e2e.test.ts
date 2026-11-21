/**
 * W5 e2e (arch §4.8, ACP row + §4.5): ACP as a thin client of the daemon —
 * the confirmations half, composed for real:
 *
 *   runTuiAcpInteractions (the REAL ACP interaction pump) →
 *   TuiRuntimeAdapter → composeTuiRemoteCliService (the port adapter) →
 *   real McodedClient → real McodedDaemon on a real unix socket → CliBridge
 *   → the daemon-side CliService double.
 *
 * The review finding: "ACP-сессии отображаются на сессии демона,
 * подтверждения идут ACP-клиенту по §4.5 (ACP-соединение — инициатор)".
 * The scenario:
 * 1. the ACP connection OPENS the turn (`stream.open sendMessage`) — it is
 *    the §4.5 п.1 initiator (`recordTurnInitiator`, keyed clientInstanceId);
 * 2. the daemon-side runtime raises `permission.ask` — the ask routes to the
 *    initiator's subscription (isolation: a co-attached window would NOT see
 *    it, pinned by the W4 e2e; here the initiator path is the one proven);
 * 3. the interaction pump maps the runtime ask onto the ACP session
 *    (`resolveSession`: acp-s1 ↔ sess-acp-1) and calls
 *    `session/request_permission` on the ACP client;
 * 4. the ACP client answers allow-once → `runtime.replyPermission` → the
 *    daemon (the §4.5 attach rule admits it — the session is attached) →
 *    the runtime resolves → `permission.resolved` terminates the ask.
 *
 * Boundary note: the acp-session ↔ runtime-session mapping enters as
 * `resolveSession` — the same shape `createTuiAcpAgent` passes (its
 * embedded-side mapping is pinned by acp-agent.test.ts). Everything above
 * (the ACP client call and reply shapes) and below (the wire, the routing,
 * the attach rule, the daemon-side resolution) is the product code.
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

import { runTuiAcpInteractions } from '../../src/acp/interactions.js';
import { TuiRuntimeAdapter } from '../../src/runtime/adapter.js';
import { composeTuiRemoteCliService } from '../../src/runtime/remote-host.js';

/** The daemon-side CliService double: the ACP turn with a tool approval. */
function acpDaemonDouble(events: PushableIterable<unknown>) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	let release: (() => void) | undefined;
	return {
		calls,
		releaseTurn: () => release?.(),
		waitForReply: async (): Promise<Record<string, unknown>> => {
			const deadline = Date.now() + 5_000;
			for (;;) {
				const reply = calls.find((call) => call.method === 'replyPermission');
				if (reply) return reply.args[0] as Record<string, unknown>;
				if (Date.now() > deadline) {
					throw new Error(`the daemon never saw replyPermission; got: ${calls.map((c) => c.method).join(', ')}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
		cli: {
			createSession: async (...args: unknown[]) => {
				calls.push({ method: 'createSession', args });
				return { sessionId: 'sess-acp-1', workspaceDir: '/tmp/w5-acp' };
			},
			getSession: async (req: { id?: string }) => ({
				sessionId: req.id ?? 'sess-acp-1',
				workspaceDir: '/tmp/w5-acp',
				archived: false,
				agentName: 'mavis',
			}),
			getPendingQuestionnaire: async () => ({}),
			listPendingPermissions: async () => ({ requests: [] }),
			replyPermission: async (...args: unknown[]) => {
				calls.push({ method: 'replyPermission', args });
				// The runtime resolved the approval — the global bus says so.
				events.push({
					type: 'permission.resolved',
					payload: {
						requestId: (args[0] as { requestId: string }).requestId,
						sessionId: 'sess-acp-1',
						decision: 'allowOnce',
					},
				});
				return { success: true };
			},
			sendMessage: async (...args: unknown[]) => {
				calls.push({ method: 'sendMessage', args });
				// Mid-turn, a tool asks for permission (the global bus event the
				// daemon routes to the turn's initiator per §4.5 п.1).
				events.push({
					type: 'permission.ask',
					payload: {
						requestId: 'ask-acp-1',
						sessionId: 'sess-acp-1',
						agentName: 'mavis',
						toolName: 'bash',
						allowAlwaysSupported: true,
					},
				});
				return {
					ok: true,
					source: (async function* () {
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						yield { dataJson: '[DONE]' };
					})(),
				};
			},
			abortSession: async () => ({ success: true }),
			steer: async (...args: unknown[]) => {
				calls.push({ method: 'steer', args });
				return { turnId: 'turn-live', mode: 'steered' };
			},
			isGoalEnabled: () => false,
			getSessionPublishStaleSessions: (): readonly string[] => [],
		},
	};
}

describe('W5 ACP e2e: confirmations route to the ACP client over the daemon (§4.5)', () => {
	let root: string;
	let daemon: McodedDaemon | undefined;
	let client: McodedClient | undefined;

	afterEach(async () => {
		client?.close();
		if (daemon) await daemon.shutdown();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it('the ACP initiator sees the ask, answers allow-once, the daemon resolves it', { timeout: 60_000 }, async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'w5-acp-')));
		writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
		const events = new PushableIterable<unknown>();
		const double = acpDaemonDouble(events);
		daemon = new McodedDaemon({
			root,
			adapter: new EchoRuntimeAdapter(),
			durableLayout: false,
			listenFd: null,
			handshake: { token: 'test-token', dataDir: root },
			hub: {
				bridge: new CliBridge({ cliService: () => double.cli as never }),
				globalEvents: events,
			},
		});
		await daemon.start();
		client = new McodedClient({
			socketPath: daemon.socketPath,
			handshake: { token: 'test-token', dataDir: root, clientInstanceId: 'acp-conn-1' },
			readyTimeoutMs: 10_000,
		});
		await client.connect();
		const { cliService } = composeTuiRemoteCliService(client);
		const runtime = new TuiRuntimeAdapter(cliService as never, { workspaceDir: '/tmp/w5-acp' });

		// 1. The ACP connection OPENS the turn → it is the §4.5 initiator.
		const opened = await (
			cliService as never as {
				sendMessage: (req: unknown, ctx: unknown) => Promise<{ ok: boolean; source?: AsyncIterable<unknown> }>;
			}
		).sendMessage({ id: 'sess-acp-1', message: 'run the tool' }, { signal: new AbortController().signal });
		expect(opened.ok).toBe(true);

		// 2–3. The interaction pump: the daemon's ask reaches the ACP client as
		// `session/request_permission`, addressed to the MAPPED acp session.
		const permissionRequests: Array<{ params: Record<string, unknown> }> = [];
		const connectionSignal = new AbortController();
		const interactions = runTuiAcpInteractions({
			runtime: runtime as never,
			connection: {
				signal: connectionSignal.signal,
				client: {
					request: async (_method: unknown, params: Record<string, unknown>) => {
						permissionRequests.push({ params });
						// The ACP client (Zed) answers: allow once.
						return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
					},
				},
			} as never,
			resolveSession: (runtimeSessionId: string) =>
				runtimeSessionId === 'sess-acp-1'
					? {
							acpSessionId: 'acp-s1',
							session: { sessionId: 'sess-acp-1', agentName: 'mavis' } as never,
							attachmentSignal: new AbortController().signal,
							isCurrent: () => true,
						}
					: undefined,
			clientCapabilities: () => ({}),
		});

		// 4. The reply crossed the wire with the §4.5 attach admission and the
		// mapped decision; the daemon's resolution ends the interaction.
		const reply = await double.waitForReply();
		expect(reply).toMatchObject({
			name: 'mavis',
			requestId: 'ask-acp-1',
			sessionId: 'sess-acp-1',
		});
		expect(permissionRequests).toHaveLength(1);
		expect(JSON.stringify(permissionRequests[0]?.params)).toContain('acp-s1');
		connectionSignal.abort();
		await interactions;
	});

	// The daemon-mode ACP steer regression (3.11 incident): the steer input
	// crosses the daemon wire as one JSON.stringify, which silently drops a
	// `preDelivery.accept` FUNCTION field — the daemon then threw
	// "r.preDelivery?.accept is not a function" and kagero surfaced the ACP
	// connection layer's bare "[internal_error] Internal error". The ACP
	// handler now pins the Turn declaratively; this pins the whole wire leg.
	it('an ACP steer reaches the daemon intact with its declarative Turn pin', { timeout: 60_000 }, async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'w5-acp-steer-')));
		writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
		const events = new PushableIterable<unknown>();
		const double = acpDaemonDouble(events);
		daemon = new McodedDaemon({
			root,
			adapter: new EchoRuntimeAdapter(),
			durableLayout: false,
			listenFd: null,
			handshake: { token: 'test-token', dataDir: root },
			hub: {
				bridge: new CliBridge({ cliService: () => double.cli as never }),
				globalEvents: events,
			},
		});
		await daemon.start();
		client = new McodedClient({
			socketPath: daemon.socketPath,
			handshake: { token: 'test-token', dataDir: root, clientInstanceId: 'acp-conn-1' },
			readyTimeoutMs: 10_000,
		});
		await client.connect();
		const { cliService } = composeTuiRemoteCliService(client);
		const runtime = new TuiRuntimeAdapter(cliService as never, { workspaceDir: '/tmp/w5-acp' });

		// Exactly the input the ACP `mcode/session/steer` handler builds for a
		// running turn (packages/tui/src/acp/extensions.ts).
		const result = await (
			runtime as unknown as { steer: (input: unknown) => Promise<unknown> }
		).steer({
			sessionId: 'sess-acp-1',
			source: 'api',
			message: { content: 'change course now' },
			producerId: 'mcode-acp',
			idempotencyKey: 'steer-req-1',
			expectActiveTurnId: 'turn-live',
		});

		expect(result).toEqual({ turnId: 'turn-live', mode: 'steered' });
		const steerCall = double.calls.find((call) => call.method === 'steer');
		expect(steerCall).toBeDefined();
		const wireInput = steerCall?.args[0] as Record<string, unknown>;
		// Lossless through the real JSON wire: reintroducing a function field
		// (the preDelivery shape) fails this round-trip exactly like production.
		expect(JSON.parse(JSON.stringify(wireInput))).toStrictEqual(wireInput);
		expect(wireInput['expectActiveTurnId']).toBe('turn-live');
		// The callback form must never appear on the wire — a JSON wire drops
		// the function and leaves the daemon a truthy `{}` to crash on.
		expect(wireInput['preDelivery']).toBeUndefined();
	});
});
