import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';

/**
 * Autonomous-activation storm guard of the background delivery (verdict 09
 * §3.3 items 3/4): at most three fast idle WAKE Turns per 60s window per owner
 * session. Deliveries that join an already-active owner Turn never touch this
 * budget — the admission hook in `conversation-delivery.ts` consults the gate
 * only for `mode: 'activated'`, so owner input and active-turn joins are never
 * rate-limited by it. When the budget is exhausted the scheduler holds the
 * batch until the window's exact release and drains everything accumulated
 * there (the documented trailing latency of idle wakes); a burst defer never
 * escalates into the transport-failure cooldown.
 */

export const DELIVERY_BURST_WINDOW_MS = 60_000;
export const MAX_DELIVERY_TURNS_PER_WINDOW = 3;
const MAX_DELIVERY_BURST_SESSIONS = 2_048;

const deliveryBursts = new WeakMap<
  LocalTaskRunnerHostWithSessionLookup,
  Map<string, { windowStartedAt: number; delivered: number }>
>();

/**
 * Consume one autonomous-activation slot, or `undefined` when the session's
 * window is exhausted (the caller defers instead of waking).
 */
export function reserveDeliveryActivationTurn(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
): { windowStartedAt: number; delivered: number } | undefined {
  const burst = getDeliveryBurst(host, ownerSessionId);
  if (burst.delivered >= MAX_DELIVERY_TURNS_PER_WINDOW) return undefined;
  burst.delivered += 1;
  return burst;
}

/**
 * Exact milliseconds until the owner session's current burst window releases
 * (plus jitter so concurrent sessions do not retry in lockstep). Always > 0:
 * a defer of zero would turn the hold into a busy loop.
 */
export function remainingDeliveryWindowMs(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
): number {
  const burst = deliveryBursts.get(host)?.get(ownerSessionId);
  const remainingMs =
    burst && burst.delivered >= MAX_DELIVERY_TURNS_PER_WINDOW
      ? Math.max(0, burst.windowStartedAt + DELIVERY_BURST_WINDOW_MS - host.nowMs())
      : 0;
  return remainingMs + 1 + Math.floor(Math.random() * 100);
}

function getDeliveryBurst(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
): { windowStartedAt: number; delivered: number } {
  let bySession = deliveryBursts.get(host);
  if (!bySession) {
    bySession = new Map();
    deliveryBursts.set(host, bySession);
  }
  const now = host.nowMs();
  const existing = bySession.get(ownerSessionId);
  if (existing && now - existing.windowStartedAt < DELIVERY_BURST_WINDOW_MS) {
    bySession.delete(ownerSessionId);
    bySession.set(ownerSessionId, existing);
    return existing;
  }
  const fresh = { windowStartedAt: now, delivered: 0 };
  bySession.set(ownerSessionId, fresh);
  if (bySession.size > MAX_DELIVERY_BURST_SESSIONS) {
    const oldest = bySession.keys().next().value;
    if (oldest !== undefined) bySession.delete(oldest);
  }
  return fresh;
}
