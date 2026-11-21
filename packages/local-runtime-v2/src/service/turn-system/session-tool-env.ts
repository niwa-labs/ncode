/**
 * The W4 per-session toolEnv provider seam (§4.4/R5).
 *
 * Module-scoped ON PURPOSE, and this is the honest note the wave asked for:
 * the snapshot lives in the daemon's hub (`SessionToolEnvStore`), while tool
 * contexts are assembled deep inside the turn system — the full DI channel
 * would thread through `CreateLocalRuntimeHostOptions` → the production
 * composition → the execution preparation, a host-contract change that is
 * DEFERRED to the daemon recomposition wave. The registry gives W4 a
 * one-line composition on the daemon side and ZERO effect elsewhere: the
 * embedded TUI and every test never set a provider, so
 * {@link readSessionToolEnv} returns `undefined` and every tool context is
 * byte-identical to the pre-W4 shape.
 *
 * @module
 */

/** Same shape as the context field (contracts.ts `toolEnv`). */
export interface SessionToolEnvSnapshot {
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

type SessionToolEnvProvider = (sessionId: string) => SessionToolEnvSnapshot | undefined;

let provider: SessionToolEnvProvider | undefined;

/** The daemon composition installs this once, after the hub exists. */
export function setSessionToolEnvProvider(next: SessionToolEnvProvider): void {
	provider = next;
}

/** Drop the provider (daemon shutdown; keeps test runs independent). */
export function clearSessionToolEnvProvider(): void {
	provider = undefined;
}

/** The live snapshot for the session, or `undefined` (tools use the daemon env). */
export function readSessionToolEnv(sessionId: string): SessionToolEnvSnapshot | undefined {
	return provider?.(sessionId);
}
