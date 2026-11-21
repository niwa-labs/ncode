/**
 * Integration for the /status source-of-truth fix (opus 2026-11-01,
 * правка 5): two product daemons on two temporary PROFILE dataDirs, each
 * inheriting its own fake credential store (a distinct loginEpoch and user
 * identity), report DIFFERENT identities through `getAccountStatus`.
 *
 * Composition note: the daemons here are the product
 * {@link LocalRuntimeV2Adapter} over a REAL local-runtime-v2 host — the
 * exact runtime `startProductDaemon` boots and the exact `CliService`
 * surface its `CliBridge` serves (`getAccountStatus` is allowlisted with
 * `{ kind: 'raw' }`). The socket shell around it is deliberately absent:
 * `product-daemon.test.ts` covers the control plane with a stubbed host
 * factory (which cannot serve account status), so this suite boots the real
 * host twice instead. The client half of the contract — enrichment only on
 * an epoch match, daemon data + warning on a mismatch — is pinned in
 * `packages/tui/test/unit/runtime-product-access.test.ts`.
 *
 * @module
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
	CreateLocalRuntimeHostOptions,
	CreatedLocalRuntimeHost,
	LocalRuntimeAuthContext,
	LocalRuntimeConfig,
} from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';

import {
	LocalRuntimeV2Adapter,
	type LocalRuntimeAdapterAuthSession,
} from '../src/local-runtime-adapter.js';
import { createLocalRuntimeHostV2ForTest } from '../../../packages/local-runtime-v2/src/runtime.js';
import { closeLocalRuntimeDb } from '../../../packages/local-runtime/src/persistence/db.js';

const TEST_TIMEOUT_MS = 120_000;

/** One fake "login" a daemon inherits: the credential-store identity. */
interface FakeIdentity {
	readonly accessToken: string;
	readonly loginEpoch: string;
	readonly userEmail: string;
	readonly userName: string;
}

interface DaemonFixture {
	readonly adapter: LocalRuntimeV2Adapter;
	readonly dataDir: string;
	readonly home: string;
	readonly identity: FakeIdentity;
}

/**
 * A profile auth session serving exactly one identity — the fake-store
 * counterpart of `createProfileAuthSession` (which would build the namespace
 * from `options.dataDir`).
 */
function fakeAuthSession(identity: FakeIdentity): LocalRuntimeAdapterAuthSession {
	const context: LocalRuntimeAuthContext = {
		accessToken: identity.accessToken,
		loginEpoch: identity.loginEpoch,
		userEmail: identity.userEmail,
		userName: identity.userName,
	};
	return {
		authContextGetter: () => context,
		authContextInvalidator: async () => undefined,
		lease: async () => context,
		dispose: () => undefined,
	};
}

/**
 * Boot one product daemon for a profile: a temporary home, the profile's
 * primary dataDir inside it, the pinned config, the fake identity store and
 * the REAL local-runtime-v2 host. Mirrors `startProductDaemon`'s adapter
 * composition (`root` = control plane, `dataDir` = data plane, auth options
 * carrying the resolved profile label).
 */
async function startProfileDaemon(
	profile: string,
	identity: FakeIdentity,
): Promise<DaemonFixture> {
	const home = await mkdtemp(join(tmpdir(), `mcoded-acct-${profile}-`));
	const dataDir = join(home, `.minimax-${profile}`);
	await mkdir(join(dataDir, 'workspace'), { recursive: true });
	const config = {
		dataDir,
		defaultModel: 'test/model',
		provider: {
			test: {
				options: { apiKey: 'test-key', baseURL: 'https://provider.test/v1' },
				models: {
					model: { modalities: { input: ['text'], output: ['text'] } },
				},
			},
		},
	} as LocalRuntimeConfig;
	const createHost = (
		options: CreateLocalRuntimeHostOptions,
	): Promise<CreatedLocalRuntimeHost> => createLocalRuntimeHostV2ForTest(options, {});
	const adapter = new LocalRuntimeV2Adapter({
		root: home,
		dataDir,
		configGetter: () => config,
		auth: { profile, env: {}, homeDir: home },
		createAuthSession: (options) => {
			// The product adapter pins the SERVED dataDir onto the auth options
			// (opus 2026-11-01, правка 3): the store — here the fake identity —
			// must be keyed by it, never by the profile label alone.
			expect(options.dataDir).toBe(dataDir);
			return fakeAuthSession(identity);
		},
		createHost,
	});
	await adapter.start();
	return { adapter, dataDir, home, identity };
}

const fixtures: DaemonFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.adapter.close().catch(() => undefined);
		closeLocalRuntimeDb(fixture.dataDir);
		await rm(fixture.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

describe('two product daemons report two identities in getAccountStatus (opus 2026-11-01, правка 5)', () => {
	it(
		'serves each /status from its own profile dataDir, store epoch and label',
		async () => {
			const one = await startProfileDaemon('one', {
				accessToken: 'token-one',
				loginEpoch: 'epoch-one',
				userEmail: 'one@example.com',
				userName: 'Owner One',
			});
			fixtures.push(one);
			const two = await startProfileDaemon('two', {
				accessToken: 'token-two',
				loginEpoch: 'epoch-two',
				userEmail: 'two@example.com',
				userName: 'Owner Two',
			});
			fixtures.push(two);

			// The exact surface the daemon's CliBridge exposes to a thin client.
			const statusOne = (await (
				one.adapter.cliService as CliService
			).getAccountStatus()) as Record<string, unknown>;
			const statusTwo = (await (
				two.adapter.cliService as CliService
			).getAccountStatus()) as Record<string, unknown>;

			// Each daemon states ITS data plane, profile label and store epoch —
			// the identity the panel must show instead of blending two accounts.
			expect(statusOne).toMatchObject({
				profile: 'one',
				dataDir: one.dataDir,
				loginEpoch: 'epoch-one',
			});
			expect(statusTwo).toMatchObject({
				profile: 'two',
				dataDir: two.dataDir,
				loginEpoch: 'epoch-two',
			});
			expect(statusOne['loginEpoch']).not.toBe(statusTwo['loginEpoch']);
			expect(statusOne['dataDir']).not.toBe(statusTwo['dataDir']);
			// Both logins are present-and-distinct at the daemon: the doctor's
			// presence booleans reflect each store's own user.
			const authOne = statusOne['auth'] as Record<string, unknown>;
			const authTwo = statusTwo['auth'] as Record<string, unknown>;
			expect(authOne).toMatchObject({ tokenPresent: true, userEmailPresent: true });
			expect(authTwo).toMatchObject({ tokenPresent: true, userEmailPresent: true });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		'keeps the identity fields off the status of an auth-less daemon',
		async () => {
			const home = await mkdtemp(join(tmpdir(), 'mcoded-acct-anon-'));
			const dataDir = join(home, '.minimax-anon');
			await mkdir(join(dataDir, 'workspace'), { recursive: true });
			const config = { dataDir, defaultModel: 'test/model' } as LocalRuntimeConfig;
			const adapter = new LocalRuntimeV2Adapter({
				root: home,
				dataDir,
				configGetter: () => config,
				// No `auth` options: a signed-out / legacy embedder — the profile
				// label and the login epoch must stay OFF the response, and the
				// client keeps its legacy enrichment gate open.
				createHost: (options) => createLocalRuntimeHostV2ForTest(options, {}),
			});
			try {
				await adapter.start();
				const status = (await (
					adapter.cliService as CliService
				).getAccountStatus()) as Record<string, unknown>;
				expect('profile' in status).toBe(false);
				expect('loginEpoch' in status).toBe(false);
				// The data plane is still stated (it is the config's own dataDir).
				expect(status['dataDir']).toBe(dataDir);
			} finally {
				await adapter.close().catch(() => undefined);
				closeLocalRuntimeDb(dataDir);
				await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
			}
		},
		TEST_TIMEOUT_MS,
	);
});
