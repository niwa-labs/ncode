/**
 * @mavis/chord-host — W08: the chord plugin-host integration over the pinned
 * vendored chord. Parallel by purpose to the public mcoded RPC; scoped facet
 * capabilities; replicated-state allowlist with one canonical writer; guarded
 * exclusive SQLite; telemetry span links across links.
 *
 * @module
 */

export {
	PluginHostContract,
	PluginHostAddress,
	FacetCapabilityScope,
	scopeFacet,
	openPluginHost,
	loadScopedFacet,
	type PluginPrincipal,
	type PluginHost,
	type PluginHostOptions,
	type InvokeHandler,
} from './host.js';
export {
	ReplicatedStateScope,
	ReplicatedStatePolicyError,
} from './state-policy.js';
export {
	ChordSqliteError,
	isDurableStorePath,
	openPluginHostSqlite,
	type GuardedChordSqlite,
} from './sqlite.js';
export {
	contextWithSpan,
	callerSpan,
	linkCallerSpan,
} from './telemetry.js';
