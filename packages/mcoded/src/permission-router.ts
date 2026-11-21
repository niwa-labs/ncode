/**
 * The PermissionRouter (arch §4.5, D5): daemon-side push routing of
 * `permission.ask` / `questionnaire.ask` events.
 *
 * Delivery target of an ask, in order:
 * 1. the window that INITIATED the active turn of the event's session — the
 *    client that opened `stream.open sendMessage`/`resumeSession`, keyed by
 *    `clientInstanceId` (not by connection): after a reconnect the same
 *    window stays the initiator and keeps receiving its approvals addressed;
 * 2. otherwise (initiator gone or never recorded) — every CONNECTED window
 *    holding an `owner` attach on the session, then `observer` attaches;
 * 3. otherwise nobody: the ask WAITS (no timeout, W0 F1) and the hub sends a
 *    non-blocking `notice{kind:'permission-waiting'}` to every connected
 *    window; with `MCODE_DETACHED_PERMISSION=deny` the hub auto-denies
 *    instead (the router only reports "no eligible window").
 *
 * Isolation (acceptance criterion 1): a window NEVER receives an ask pushed
 * for another window's turn while the initiator is connected — the fallback
 * kicks in only when no initiator window is connected. `permission.resolved`
 * is NOT ask-routing: it rides the ordinary session route (attached windows
 * close their dialogs, §4.5 п.4).
 *
 * The router is plain-data in, plain-data out (no sockets, no clocks) so the
 * hub keeps owning frames and the table stays unit-testable.
 *
 * @module
 */

/** Ask event types the router routes (everything else passes untouched). */
export const ASK_EVENT_TYPES: ReadonlySet<string> = new Set([
	'permission.ask',
	'questionnaire.ask',
]);

/** The one connection fact the router needs. */
export interface RoutableClient {
	/** Stable identity from hello v2; `null` on the v1 shim. */
	readonly clientInstanceId: string | null;
	/** sessionId → attach role currently held by this connection. */
	readonly attachments: ReadonlyMap<string, 'owner' | 'observer'>;
}

/** The event shape the router reads (structural: `{type, payload}`). */
export interface RoutableEvent {
	readonly type?: unknown;
	readonly payload?: unknown;
}

/** sessionId of a routed event, or `undefined` when it carries none. */
export function routedEventSessionId(event: RoutableEvent): string | undefined {
	if (typeof event.payload !== 'object' || event.payload === null) return undefined;
	const sessionId = (event.payload as { sessionId?: unknown }).sessionId;
	return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/** Bounded memory: at most this many session → initiator claims. */
const MAX_INITIATOR_ENTRIES = 256;

export class PermissionRouter {
	/** sessionId → initiator key (`clientInstanceId` or `conn:<id>`). */
	private readonly initiators = new Map<string, string>();

	/**
	 * Record the initiator of the session's active turn. A new turn for the
	 * same session overwrites the claim (the freshest window drives it).
	 *
	 * `clientKey` is the clientInstanceId whenever hello v2 provided one. The
	 * `conn:<id>` fallback (v1 shims without hello v2) is BOOKKEEPING ONLY:
	 * {@link routeAsk} matches `clientInstanceId` exclusively, so a
	 * connection-keyed claim never matches and the ask simply falls back to
	 * the attach chain — which is the correct behavior for a shim that has no
	 * stable window identity.
	 */
	recordTurnInitiator(sessionId: string, clientKey: string): void {
		while (this.initiators.size >= MAX_INITIATOR_ENTRIES) {
			const oldest = this.initiators.keys().next().value;
			if (oldest === undefined) break;
			this.initiators.delete(oldest);
		}
		this.initiators.set(sessionId, clientKey);
	}

	/** The recorded initiator key of the session's (last seen) turn. */
	turnInitiator(sessionId: string): string | undefined {
		return this.initiators.get(sessionId);
	}

	/** Drop one client's claims (shutdown bookkeeping; bounded map regardless). */
	dropClient(clientKey: string): void {
		for (const [sessionId, key] of this.initiators) {
			if (key === clientKey) this.initiators.delete(sessionId);
		}
	}

	/**
	 * Whether one live GlobalEvent may reach one subscribed connection.
	 * `false` only for ask events whose eligible targets exclude the client —
	 * every other event follows the ordinary routing table (`scope` +
	 * attachments), which the caller applies separately.
	 */
	allowsDelivery(client: RoutableClient, event: RoutableEvent, connected: readonly RoutableClient[]): boolean {
		const type = typeof event.type === 'string' ? event.type : undefined;
		if (type === undefined || !ASK_EVENT_TYPES.has(type)) return true;
		const sessionId = routedEventSessionId(event);
		if (sessionId === undefined) return true; // no routing key: ordinary rules
		const targets = this.routeAsk(sessionId, connected);
		return targets.includes(client);
	}

	/**
	 * The eligible targets of one ask on `sessionId` among `connected`
	 * (§4.5 п.1-2): the connected initiator window(s), else owner-attached
	 * windows, else observer-attached windows, else nobody (the ask waits).
	 */
	routeAsk<T extends RoutableClient>(
		sessionId: string,
		connected: readonly T[],
	): readonly T[] {
		const initiatorKey = this.initiators.get(sessionId);
		if (initiatorKey !== undefined) {
			const initiatorWindows = connected.filter(
				(client) => client.clientInstanceId !== null && client.clientInstanceId === initiatorKey,
			);
			if (initiatorWindows.length > 0) return initiatorWindows;
		}
		const owners = connected.filter(
			(client) => client.attachments.get(sessionId) === 'owner',
		);
		if (owners.length > 0) return owners;
		return connected.filter((client) => client.attachments.get(sessionId) === 'observer');
	}
}
