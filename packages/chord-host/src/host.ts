/**
 * The chord plugin-host integration (W08; merge-map row "mcoded ↔ coding-agent
 * modes/rpc" — port-plan.md:506: "Chord JSON links — отдельный plugin-host
 * transport, не второй product RPC"; §2.4.6 A6 :198 — chord host/reload/
 * replication/JSON links stay a self-standing host infrastructure, parallel
 * BY PURPOSE to the public mcoded RPC).
 *
 * This package is deliberately NOT a second product RPC: it hosts PLUGIN
 * facets over chord links. The one served contract is the plugin-host
 * transport; mcoded keeps the product protocol untouched.
 *
 * Scoped capabilities (the §4.1 chord row): a facet installed through
 * {@link scopeFacet} may `serve()` ONLY contracts on the host's allowlist —
 * an unlisted contract fails CLOSED at facet setup, not at first call.
 *
 * @module
 */

import {
	createHost,
	defineFacet,
	constant,
	hostKind,
	method,
	obj,
	opt,
	remote,
	str,
	unknown,
	type Contract,
	type Facet,
	type FacetHost,
	type Ctx,
	type Host,
	type Link,
	type PluginFacet,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

import { createLogger } from '@mavis/logging';

const log = createLogger('mcode:chord-host');

/** Principal of the plugin-host graph (JSON-serializable, per chord). */
export type PluginPrincipal = {
	readonly kind: 'plugin-host' | 'plugin';
	readonly id: string;
};

/** The ONE plugin-host transport contract (state + invocation). */
export const PluginHostAddress = hostKind('plugin-host');
export const PluginHostContract = remote('mcode.plugin-host.v1', {
	version: 1,
	params: { plugin: str() },
	hostAddress: () => PluginHostAddress(),
	variants: {
		main: {
			state: { readiness: str() },
			methods: {
				invoke: method(obj({ op: str(), payload: opt(unknown()) }), unknown()),
			},
		},
	},
});

/** A dispatch target the plugin host exposes through `invoke`. */
export type InvokeHandler = (
	payload: unknown,
	context: { readonly signal: AbortSignal | undefined },
) => unknown | Promise<unknown>;

/** Host-scoped capability allowlist: which contracts facets may serve. */
export class FacetCapabilityScope {
	readonly #allowed = new Set<string>();

	constructor(allowed: readonly string[]) {
		for (const name of allowed) this.#allowed.add(name);
	}

	/** Register one more servable contract name (host-owned policy change). */
	allow(name: string): void {
		this.#allowed.add(name);
	}

	/** Fail-closed check used by {@link scopeFacet}. */
	assertServeAllowed(contract: Contract): void {
		if (!this.#allowed.has(contract.name)) {
			throw new Error(
				`facet is not allowed to serve contract ${contract.name}; add it to the plugin-host capability allowlist`,
			);
		}
	}
}

/** Wrap a facet so its `serve` calls pass the capability scope (fail-closed). */
export function scopeFacet<P extends PluginPrincipal = PluginPrincipal>(
	facet: Facet<P>,
	scope: FacetCapabilityScope,
): Facet<P> {
	return {
		setup: (api: FacetHost<P>, self) => {
			const scoped: FacetHost<P> = {
				...api,
				serve: ((...args: Parameters<FacetHost<P>['serve']>) => {
					scope.assertServeAllowed(args[0] as unknown as Contract);
					return (api.serve as (...a: unknown[]) => void)(...args);
				}) as FacetHost<P>['serve'],
			};
			facet.setup(scoped, self);
		},
	};
}

export interface PluginHostOptions {
	readonly name?: string;
	/** Ops the plugin host dispatches through the contract's `invoke`. */
	readonly ops?: Readonly<Record<string, InvokeHandler>>;
	readonly onError?: (error: unknown) => void;
}

export interface PluginHost {
	readonly host: Host<PluginPrincipal>;
	readonly scope: FacetCapabilityScope;
	/** Initial native load barrier. */
	readonly ready: Promise<void>;
	/** Serve one more op on the plugin contract (host-owned dispatch table). */
	registerOp(op: string, handler: InvokeHandler): void;
	/** Accept one plugin link (requests act as the given principal). */
	accept(link: Link, principal: PluginPrincipal): void;
	close(): Promise<void>;
}

/**
 * Open the plugin host: the core facet serves the plugin-host contract with a
 * host-owned dispatch table. The scope initially allows ONLY that contract;
 * plugin facets are installed via {@link loadScopedFacet}.
 */
const facetMutations = new WeakMap<PluginHost, Promise<void>>();
const installedFacets = new WeakMap<
	PluginHost,
	Map<string, PluginFacet<PluginPrincipal>>
>();

export function openPluginHost(options: PluginHostOptions = {}): PluginHost {
	const ops = new Map<string, InvokeHandler>(Object.entries(options.ops ?? {}));
	ops.set('mcode.ping', () => ({ pong: true, at: Date.now() }));
	const scope = new FacetCapabilityScope([PluginHostContract.name]);
	const coreFacetDefinition = defineFacet<PluginPrincipal>((api) => {
		api.serve(PluginHostContract, (input, _principal, self) => {
			const status = constant('ready');
			return {
				variant: 'main',
				members: {
					readiness: status,
					invoke: async (
						args: { readonly op: string; readonly payload?: unknown },
						ctx: Ctx<PluginPrincipal>,
					) => {
						const handler = ops.get(args.op);
						if (handler === undefined) {
							throw new Error(`plugin host has no op ${args.op}`);
						}
						return handler(args.payload, { signal: ctx.abortSignal });
					},
				},
			};
		});
	});

	const coreFacet: PluginFacet<PluginPrincipal> = {
		name: 'mcode.plugin-host.core',
		facet: coreFacetDefinition,
	};
	const host = createHost<PluginPrincipal>({
		principal: { kind: 'plugin-host', id: options.name ?? 'core' },
		address: PluginHostAddress(),
		onError: (error) => {
			log.error('plugin host background failure', {
				error: error instanceof Error ? error.message : String(error),
			});
			options.onError?.(error);
		},
	});
	const ready = host.load([coreFacet], BACKGROUND_CONTEXT).then((report) => {
		if (report.failed.length) throw report.failed[0].error;
	});
	// Keep the rejection observable through `ready` without an unhandled rejection.
	void ready.catch((error) => options.onError?.(error));

	const pluginHost: PluginHost = {
		host,
		scope,
		ready,
		registerOp: (op, handler) => {
			ops.set(op, handler);
		},
		accept: (link, principal) => {
			host.accept(link, { principal }, BACKGROUND_CONTEXT);
		},
		close: () => host.close(BACKGROUND_CONTEXT),
	};
	installedFacets.set(pluginHost, new Map([[coreFacet.name, coreFacet]]));
	return pluginHost;
}

/** Install a plugin facet under the capability scope (hot-reloadable). */
export function loadScopedFacet(
	host: PluginHost,
	facet: Facet<PluginPrincipal> | PluginFacet<PluginPrincipal>,
): Promise<void> {
	const prior = facetMutations.get(host) ?? host.ready;
	const mutation = prior
		.catch(() => {})
		.then(async () => {
			await host.ready;
			const definition = 'facet' in facet ? facet.facet : facet;
			const name =
				'facet' in facet
					? facet.name
					: `mcode.plugin.facet.${crypto.randomUUID()}`;
			const facets = installedFacets.get(host)!;
			const next = new Map(facets);
			next.set(name, { name, facet: scopeFacet(definition, host.scope) });
			const report = await host.host.reload(
				[...next.values()],
				BACKGROUND_CONTEXT,
			);
			if (report.failed.length) throw report.failed[0].error;
			installedFacets.set(host, next);
		});
	facetMutations.set(host, mutation);
	return mutation;
}
