/**
 * Wave 1 (verdict §3.4) at the HUB level: runtime-internal owner turns —
 * the wake turns the runtime activated itself (background-task delivery with
 * no client window) — are first-class for the daemon's event surface and its
 * busy/drain views:
 *
 * 1. A wake turn that ran with NO client attached still lands in the replay
 *    ring: a client that connects afterwards receives the full
 *    started/frames/terminal triple from replay (acceptance 18 "reconnect
 *    receives replay/history").
 * 2. An idle restart (`daemon.restart{when:'idle'}`) HOLDS while an internal
 *    turn is live — the client `liveTurnStreams` alone do not describe the
 *    runtime's work — and fires once the wake turn settles ("idle restart
 *    does not tear down the internal turn").
 * 3. `daemon.status` counts the internal turn in `activeTurns`/`activeRuns`
 *    (the `mcode daemon stop` drain guard's input) with the
 *    `internal-runtime-turn` marker.
 *
 * Harness: the same wire-level rig as `w5-skew-restart-watchdog.test.ts`,
 * with a stub RuntimeAdapter whose event stream and `internalTurns()` the
 * test controls directly.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeAdapter, RuntimeSubmission } from '../src/runtime-adapter.js';
import { PushableIterable } from '../src/runtime-adapter.js';
import { McodedHub } from '../src/hub.js';
import { attachClient, hello, setupHub, waitForSuccess } from './helpers.js';

/** A RuntimeAdapter double with a test-controlled event stream and busy view. */
class ControlledRuntimeAdapter implements RuntimeAdapter {
	private readonly stream = new PushableIterable<unknown>();
	readonly events: AsyncIterable<unknown> = this.stream;
	/** Live runtime-internal turns as the daemon's busy/drain views see them. */
	private readonly internal: Array<{
		sessionId: string;
		turnId: string;
		startedAtMs: number;
	}> = [];

	push(event: unknown): void {
		this.stream.push(event);
	}

	addInternalTurn(turnId: string): void {
		this.internal.push({ sessionId: 's-owner', turnId, startedAtMs: Date.now() });
	}

	clearInternalTurns(): void {
		this.internal.length = 0;
	}

	internalTurns() {
		return [...this.internal];
	}

	async submit(_submission: RuntimeSubmission): Promise<void> {}

	async abort(): Promise<void> {}

	stop(): void {
		this.stream.end();
	}
}

function wakeEventTrip(): Array<Record<string, unknown>> {
	const requestId = 'background-delivery:turn_wake_1';
	const sessionId = 's-owner';
	return [
		{ type: 'turn_started', requestId, sessionId, turnId: 'turn_wake_1', origin: 'background-delivery' },
		{
			type: 'turn_frame',
			requestId,
			sessionId,
			origin: 'background-delivery',
			frame: { dataJson: '{"type":2,"agent_message":{"role":"assistant","msg_content":"the wake reply"}}' },
		},
		{ type: 'turn_completed', requestId, sessionId, turnId: 'turn_wake_1', origin: 'background-delivery' },
	];
}

describe('Wave 1 hub surface for runtime-internal turns', () => {
	it('a wake turn that ran with NO client is replayed in full to a late client (acceptance 18)', async () => {
		const adapter = new ControlledRuntimeAdapter();
		const { hub } = await setupHub({ adapter });

		// The wake happens with no client attached: the daemon keeps draining
		// (I-DETACH at the adapter boundary) and the ring retains the events.
		for (const event of wakeEventTrip()) adapter.push(event);
		await vi_waitForFrames(hub, 3);

		// A client connects AFTER the wake completed and subscribes.
		const late = attachClient(hub, 'late');
		await hello(late);
		late.send({ type: 'events' });
		const attachResponse = await waitForSuccess(late, (frame) => frame.command === 'events');
		expect(attachResponse.data).toMatchObject({ replayed: 3, head: '3' });

		const replayed = await late.events(3);
		expect(replayed.map((frame) => (frame.event as { type: string }).type)).toEqual([
			'turn_started',
			'turn_frame',
			'turn_completed',
		]);
		const started = replayed[0]?.event as { turnId?: string; origin?: string };
		const completed = replayed[2]?.event as { turnId?: string; origin?: string };
		// Identity is the runtime (sessionId, turnId) pair, marked as a
		// background delivery — not a client requestId — and the TRUE outcome.
		expect(started.turnId).toBe('turn_wake_1');
		expect(started.origin).toBe('background-delivery');
		expect(completed.turnId).toBe('turn_wake_1');
		expect(completed.origin).toBe('background-delivery');
	});

	it('an idle restart HOLDS while an internal turn is live, fires after it settles', async () => {
		const adapter = new ControlledRuntimeAdapter();
		const restarts: string[] = [];
		const { hub } = await setupHub({
			adapter,
			idleRestartPollMs: 5,
			onRestartRequested: (when) => {
				restarts.push(when);
			},
		});
		const client = attachClient(hub, 'w');
		await hello(client);

		// The runtime activated a wake turn on its own (no client stream).
		adapter.addInternalTurn('turn_wake_1');
		expect(hub.activeTurnCount).toBe(1);
		expect(hub.listActiveTurns()).toEqual([
			{ sessionId: 's-owner', method: 'internal-runtime-turn', elapsedMs: expect.any(Number) },
		]);

		client.send({ type: 'daemon.restart', id: 'r1', when: 'idle' });
		const scheduled = await waitForSuccess(client, (frame) => frame.command === 'daemon.restart');
		expect(scheduled.data).toMatchObject({ scheduled: true, activeTurns: 1, pendingPermissions: 0 });
		// The restart must NOT fire while the wake turn runs.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(restarts).toEqual([]);

		// The wake turn settles → the daemon drains.
		adapter.clearInternalTurns();
		await vi.waitFor(() => expect(restarts).toEqual(['idle']), { timeout: 2_000 });
		expect(hub.activeTurnCount).toBe(0);
	});

	it('daemon.status reports the internal turn in activeTurns/activeRuns for the drain guard', async () => {
		const adapter = new ControlledRuntimeAdapter();
		const { hub } = await setupHub({ adapter });
		const client = attachClient(hub, 'w');
		await hello(client);

		adapter.addInternalTurn('turn_wake_1');
		client.send({ type: 'daemon.status', id: 'st1' });
		const status = await waitForSuccess(client, (frame) => frame.command === 'daemon.status');
		const statusData = status.data as {
			activeTurns: number;
			activeRuns: { sessionId: string; method: string; elapsedMs: number }[];
		};
		expect(statusData.activeTurns).toBe(1);
		expect(statusData.activeRuns).toEqual([
			{ sessionId: 's-owner', method: 'internal-runtime-turn', elapsedMs: expect.any(Number) },
		]);

		adapter.clearInternalTurns();
		client.send({ type: 'daemon.status', id: 'st2' });
		const idle = await waitForSuccess(client, (frame) => frame.command === 'daemon.status');
		const idleData = idle.data as { activeTurns: number; activeRuns: unknown[] };
		expect(idleData.activeTurns).toBe(0);
		expect(idleData.activeRuns).toEqual([]);
	});
});

/** Wait until the hub ring retained `count` frames (the pump is async). */
async function vi_waitForFrames(hub: McodedHub, count: number): Promise<void> {
	await vi.waitFor(() => {
		expect(Number(hub.head)).toBeGreaterThanOrEqual(count);
	}, { timeout: 2_000, interval: 10 });
}
