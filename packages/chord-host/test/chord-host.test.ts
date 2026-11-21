/**
 * W08 chord tests — host integration, scoped capabilities, hot reload,
 * replicated-state policy, and the plugin RPC over chord JSON links
 * (memoryLinkPair), against the PINNED vendored chord.
 *
 * The plugin host is parallel BY PURPOSE to the public mcoded RPC (this file
 * does not touch mcoded): chord JSON links are the plugin-host transport.
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	createHost,
	defineFacet,
	constant,
	memoryLinkPair,
	remote,
	num,
	str,
	type Facet,
} from '@earendil-works/chord';
import { afterAll, describe, expect, it } from 'vitest';

import {
	FacetCapabilityScope,
	PluginHostContract,
	loadScopedFacet,
	openPluginHost,
	scopeFacet,
	type PluginPrincipal,
	PluginHostAddress,
} from '../src/index.js';
import {
	ReplicatedStatePolicyError,
	ReplicatedStateScope,
} from '../src/index.js';

const directories: string[] = [];
const context = BACKGROUND_CONTEXT;

afterAll(() => {
	for (const directory of directories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort: the OS temp root is wiped anyway.
		}
	}
});

describe('plugin host RPC over chord JSON links', () => {
	it('serves the plugin contract over a memory link and dispatches host-owned ops', async () => {
		const pluginHost = openPluginHost({
			ops: {
				'mcode.echo': (payload) => ({ echoed: payload }),
			},
		});
		try {
			const [down, up] = memoryLinkPair();
			pluginHost.accept(down, { kind: 'plugin', id: 'p1' });
			await pluginHost.ready;
			const client = createHost<PluginPrincipal>({ onError: () => {} });
			await client.load([], context);
			client.connect(
				up,
				{ principal: { kind: 'plugin-host', id: 'core' } },
				context,
			);
			try {
				const ref = await client.get(
					PluginHostContract,
					{ plugin: 'p1' },
					context,
				);
				const pong = (await ref.invoke({ op: 'mcode.ping' }, context)) as {
					pong: boolean;
				};
				expect(pong.pong).toBe(true);
				const echoed = (await ref.invoke(
					{ op: 'mcode.echo', payload: { n: 7 } },
					context,
				)) as { echoed: { n: number } };
				expect(echoed.echoed.n).toBe(7);
				// Unknown ops fail with a diagnosable error (fail-closed dispatch).
				await expect(ref.invoke({ op: 'mcode.nope' }, context)).rejects.toThrow(
					/no op mcode.nope/,
				);
				ref.release();
			} finally {
				await client.close(context);
			}
		} finally {
			await pluginHost.close();
		}
	});
});

describe('scoped plugin-host capabilities', () => {
	it('fails closed when a facet serves an unlisted contract, and allows listed ones', async () => {
		const pluginHost = openPluginHost({});
		try {
			const Foreign = remote('mcode.plugin.foreign.v1', {
				version: 1,
				params: {},
				hostAddress: () => PluginHostAddress(),
				variants: { main: { state: { n: num() } } },
			});
			const foreignFacet: FacetDefinitionish = {
				setup: (api) => {
					api.serve(Foreign, (_input, _principal, self) => {
						const n = constant(1);
						return { variant: 'main', members: { n } };
					});
				},
			};
			// The unlisted contract is refused at SETUP (fail-closed), not at call.
			await expect(loadScopedFacet(pluginHost, foreignFacet)).rejects.toThrow(
				/capability allowlist/,
			);

			// Allowing the contract lets the same facet install.
			pluginHost.scope.allow(Foreign.name);
			await loadScopedFacet(pluginHost, foreignFacet);
			await pluginHost.ready;
		} finally {
			await pluginHost.close();
		}
	});

	it('hot-reloads a facet: the replacement serves new behavior while the host survives', async () => {
		const pluginHost = openPluginHost({});
		try {
			// The reload facet serves its OWN contract (the plugin contract is the
			// core facet's); chord hot reload replaces everything a facet served.
			pluginHost.scope.allow('mcode.test.reload.v1');
			const Reloaded = remote('mcode.test.reload.v1', {
				version: 1,
				params: {},
				hostAddress: () => PluginHostAddress(),
				variants: { main: { state: { servedByTag: str() } } },
			});
			const makeFacet = (tag: string): FacetDefinitionish => ({
				setup: (api) => {
					api.serve(Reloaded, (_input, _principal, self) => {
						const servedByTag = constant(tag);
						return {
							variant: 'main',
							members: { servedByTag },
						};
					});
				},
			});
			await loadScopedFacet(pluginHost, {
				name: 'mcode.test.facet',
				facet: makeFacet('v1'),
			});

			const [down, up] = memoryLinkPair();
			pluginHost.accept(down, { kind: 'plugin', id: 'p1' });
			await pluginHost.ready;
			const client = createHost<PluginPrincipal>({ onError: () => {} });
			await client.load([], context);
			client.connect(
				up,
				{ principal: { kind: 'plugin-host', id: 'core' } },
				context,
			);
			try {
				const ref1 = await client.get(Reloaded, {}, context);
				expect(ref1.servedByTag.value).toBe('v1');
				ref1.release();

				// HOT RELOAD: same facet name, new code version; the host and the
				// link survive, new references see the replacement.
				const Other = remote('mcode.test.other.v1', {
					version: 1,
					params: {},
					hostAddress: () => PluginHostAddress(),
					variants: { main: { state: { tag: str() } } },
				});
				pluginHost.scope.allow(Other.name);
				await Promise.all([
					loadScopedFacet(pluginHost, {
						name: 'mcode.test.facet',
						facet: makeFacet('v2'),
					}),
					loadScopedFacet(pluginHost, {
						name: 'mcode.test.other',
						facet: defineFacet<PluginPrincipal>((api) => {
							api.serve(Other, () => ({
								variant: 'main',
								members: { tag: constant('other') },
							}));
						}),
					}),
				]);
				const other = await client.get(Other, {}, context);
				expect(other.tag.value).toBe('other');
				other.release();
				const core = await client.get(
					PluginHostContract,
					{ plugin: 'p1' },
					context,
				);
				expect(await core.invoke({ op: 'mcode.ping' }, context)).toMatchObject({
					pong: true,
				});
				core.release();

				const ref2 = await client.get(Reloaded, {}, context);
				expect(ref2.servedByTag.value).toBe('v2');
				ref2.release();
			} finally {
				await client.close(context);
			}
		} finally {
			await pluginHost.close();
		}
	});
});

describe('replicated-state policy (one canonical writer per allowlisted kind)', () => {
	it('refuses unregistered kinds and second writers, and delivers canonical updates to views', async () => {
		const scope = new ReplicatedStateScope(['mcode.roster-view']);
		expect(() => scope.sourceFor('mcode.unlisted', { count: 0 })).toThrow(
			ReplicatedStatePolicyError,
		);

		const source = scope.sourceFor('mcode.roster-view', { count: 0 });
		expect('change' in source).toBe(false);
		expect(Object.isFrozen(source.value)).toBe(true);
		expect(() => scope.sourceFor('mcode.roster-view', { count: 100 })).toThrow(
			/canonical writer/,
		);

		const seen: number[] = [];
		const view = scope.view<{ count: number }>('mcode.roster-view');
		const watch = await view.watch(context);
		watch.start(async (call) => {
			if (call.kind === 'value') seen.push(call.value.count);
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect('change' in view).toBe(false);
		scope.publish<{ count: number }>(
			'mcode.roster-view',
			(draft) => {
				draft.count = 41;
			},
			context,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		scope.publish<{ count: number }>(
			'mcode.roster-view',
			(draft) => {
				draft.count = 42;
			},
			context,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		// The canonical writer is the ONLY writer; the read-only view observed
		// both revisions in order.
		// The view hydrates the initial value, then both canonical revisions.
		expect(seen).toEqual([0, 41, 42]);
		await watch.stop();
	});
});

// Local structural type so the tests can define facets without importing the
// wider chord surface here.
interface FacetDefinitionish {
	readonly setup: (
		api: Parameters<Parameters<typeof defineFacet>[0]>[0],
	) => void;
}

// Re-exported so the helper type above stays tied to the real API.
void (undefined as unknown as FacetCapabilityScope | undefined);
void (undefined as unknown as ReturnType<typeof openPluginHost> | undefined);
