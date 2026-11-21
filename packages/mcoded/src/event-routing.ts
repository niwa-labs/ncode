/**
 * The v2 event routing table (arch §4.3.4): which GlobalEvents broadcast to
 * every subscribed window ("catalog") and which go only to windows holding a
 * `session.attach` on the event's session ("session").
 *
 * The table is TOTAL over `@mavis/shared/global-events`' `GLOBAL_EVENT_TYPES`
 * — the `satisfies Record<GlobalEventType, GlobalEventRoute>` makes a missing
 * or misspelled entry a compile error, and the completeness test re-checks it
 * at runtime against the shared catalog. Unknown (future) event types fall
 * open per the arch: with a `payload.sessionId` they ride the attach route
 * (never broadcast into unrelated windows), without one they broadcast (so a
 * UI is never blind to new global event kinds).
 *
 * `session.publish_conflict` is not named in the arch table sketch but is
 * session-scoped banner material (W1 §3.4: "the window renders it like other
 * session warnings"), so it rides the attach route.
 *
 * @module
 */

import type { GlobalEventType } from '@mavis/shared/global-events';

/** Delivery class of a GlobalEvent type (arch §4.3.4). */
export type GlobalEventRoute = 'catalog' | 'session';

/**
 * The routing table — catalog events are low-frequency, window-independent;
 * session-runtime events only concern windows attached to that session.
 */
export const GLOBAL_EVENT_ROUTES = {
	// catalog: broadcast to every subscribed window
	'agent.created': 'catalog',
	'agent.updated': 'catalog',
	'session.created': 'catalog',
	'session.visibility_updated': 'catalog',
	'session.deleted': 'catalog',
	'session.pinned_updated': 'catalog',
	'session.title_updated': 'catalog',
	'session.model_updated': 'catalog',
	'config.permission_mode.changed': 'catalog',
	'config.browser_use_tooling.changed': 'catalog',
	'notification.read': 'catalog',
	'notification.refresh': 'catalog',
	'rotation.completed': 'catalog',
	// session-runtime: only windows attached to the event's session
	'session.interaction_mode.changed': 'session',
	'session.start': 'session',
	'session.finish': 'session',
	'session.error': 'session',
	'session.abort': 'session',
	'session.queue.updated': 'session',
	'session.compaction.started': 'session',
	'session.compaction.progress': 'session',
	'session.compaction.completed': 'session',
	'session.compaction.failed': 'session',
	'session.llm_retry': 'session',
	'session.publish_conflict': 'session',
	'permission.ask': 'session',
	'permission.resolved': 'session',
	'questionnaire.ask': 'session',
	'questionnaire.dismiss': 'session',
	'questionnaire.superseded': 'session',
	'message.rewind': 'session',
	'content.retry.exceeded': 'session',
	'thread_goal.updated': 'session',
	'thread_goal.cleared': 'session',
	'thread_goal.objective_updated_steering': 'session',
	'workspace.git.changed': 'session',
	'turn.prompt_suggestion.status': 'session',
	'turn.prompt_suggestion.generated': 'session',
} as const satisfies Record<GlobalEventType, GlobalEventRoute>;

/** Classify one event type; `'unknown'` types follow the fail-open rule. */
export function routeGlobalEventType(type: unknown): GlobalEventRoute | 'unknown' {
	if (typeof type !== 'string') return 'unknown';
	const routed = (GLOBAL_EVENT_ROUTES as Record<string, GlobalEventRoute | undefined>)[type];
	return routed ?? 'unknown';
}

/**
 * Extract the routing session of one GlobalEvent frame (`{type, payload}`).
 * The event arrives as an opaque JSON value from the runtime bus, so the
 * probe stays structural: only a string `payload.sessionId` counts.
 */
export function globalEventSessionId(event: unknown): string | undefined {
	if (typeof event !== 'object' || event === null) return undefined;
	const payload = (event as { payload?: unknown }).payload;
	if (typeof payload !== 'object' || payload === null) return undefined;
	const sessionId = (payload as { sessionId?: unknown }).sessionId;
	return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Whether one subscribed connection receives one GlobalEvent.
 *
 * - `scope: 'all'` — everything (mcode exec --watch, debugging);
 * - `scope: 'catalog+attached'` — catalog events always; session events and
 *   unknown-with-sessionId events only when `attachedSessionIds` holds the
 *   event's session; unknown-WITHOUT-sessionId events always (fail-open).
 */
export function shouldDeliverGlobalEvent(
	event: unknown,
	scope: 'catalog+attached' | 'all',
	attachedSessionIds: ReadonlySet<string>,
): boolean {
	if (scope === 'all') return true;
	const type = (event as { type?: unknown } | null | undefined)?.type;
	const route = routeGlobalEventType(type);
	if (route === 'catalog') return true;
	const sessionId = globalEventSessionId(event);
	if (sessionId === undefined) return route === 'unknown' ? true : false;
	return attachedSessionIds.has(sessionId);
}
