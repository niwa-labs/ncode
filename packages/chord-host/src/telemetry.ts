/**
 * Telemetry propagation across chord links (W08 T-row "telemetry addLink"):
 * the caller's span rides the chord Context (`withTelemetry`), the provider
 * side reads it off the invocation context and attaches a LINK to it
 * (`span.addLink({ context })` — the same pattern the pinned pi-durable
 * submissions use), so a plugin-host invocation joins the caller's trace
 * without sharing its spans.
 *
 * @module
 */

import { withTelemetry, type Context } from '@earendil-works/chord/context';
import type { TelemetrySpan } from '@earendil-works/pi-telemetry';

/** Attach a settled caller span to a context (client side). */
export function contextWithSpan(span: TelemetrySpan, parent: Context = BACKGROUND): Context {
	return withTelemetry(span, parent);
}

import { BACKGROUND_CONTEXT as BACKGROUND } from '@earendil-works/chord/context';

/** The caller's span, as seen on the provider side (`NOOP` when absent). */
export function callerSpan(context: Context): TelemetrySpan {
	return context.telemetry;
}

/** Attach a LINK to `span` pointing at the caller's context (provider side). */
export function linkCallerSpan(span: TelemetrySpan, callerContext: Context): void {
	span.addLink({ context: callerContext.telemetry });
}
