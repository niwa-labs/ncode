/**
 * Regression tests for the profile auth-lease refresh chain of
 * `createProfileAuthSession`: a failed lease must never kill the refresh
 * chain. The pre-fix catch arm dropped `cachedLease` without re-arming the
 * timer, so a single transient failure left the daemon without a managed
 * bearer (every turn failing with the resolver's credential error) until the
 * process restarted.
 *
 * The suite drives the REAL product session over a REAL oauth-core file store
 * in a temp home — no adapter, no network. The OAuth endpoints point at
 * loopback port 1 (always refused) so no code path can reach a real identity
 * provider; failures are produced fully offline:
 * - a missing store is the signed-out class (`AuthRequiredError`), and
 * - a corrupt credential record is the transient class: the store read fails
 *   before any refresh request could be attempted.
 *
 * Time (`Date` + `setTimeout`) is faked so the 30 s/60 s retry ladder runs in
 * milliseconds; the fake clock is never advanced across a SCHEDULED refresh
 * boundary (expiry minus the 60 s margin) because the frozen clock would turn
 * the boundary's zero-delay reschedule into a loop that cannot exist with a
 * real, advancing clock. After advancing the clock, poll the observable
 * result on Vitest's real timers while the filesystem work completes.
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	getPrimaryDataDirPath,
	getRuntimeBuildEnv,
	getRuntimeRegion,
	PROFILE_ENV_VAR,
	resolveProfileDataDirPaths,
} from '@mavis/config';
import {
	createAuthNamespace,
	FileStore,
	MCODE_OAUTH_AUDIENCE,
	MCODE_OAUTH_CLIENT_ID,
	MCODE_OAUTH_SCOPES,
	type AuthState,
	type StoredCredential,
} from '@mavis/oauth-core';

import {
	createProfileAuthSession,
	createProfileOAuthCore,
	type LocalRuntimeAdapterAuthSession,
} from '../src/local-runtime-adapter.js';
import { startProductDaemon } from '../src/product-daemon.js';
import type { CreatedLocalRuntimeHost } from '@mavis/local-runtime-v2/process-local';
import { createRemoteRuntimeHost } from '../../tui/src/runtime/remote-host.js';

/** Offline endpoints: https scheme is required; loopback port 1 always refuses. */
const OFFLINE_ENDPOINTS = {
	MCODE_OAUTH_DEVICE_AUTHORIZATION_ENDPOINT: 'https://127.0.0.1:1/device',
	MCODE_OAUTH_TOKEN_ENDPOINT: 'https://127.0.0.1:1/token',
	MCODE_OAUTH_REVOCATION_ENDPOINT: 'https://127.0.0.1:1/revoke',
} as const;

/** `expiresAtMs` of a seeded credential: valid for the whole test timeline. */
const SEEDED_VALIDITY_MS = 10 * 60_000;

interface SeededLease {
	readonly accessToken: string;
	readonly generation: number;
}

/** The namespace `createProfileAuthSession` resolves for a data directory. */
function namespaceForDataDir(dataDir: string) {
	return createAuthNamespace({
		dataDir,
		buildEnv: getRuntimeBuildEnv(),
		region: getRuntimeRegion(),
	});
}

/** The namespace `createProfileAuthSession` resolves for the default profile. */
function profileNamespace(homeDir: string) {
	return namespaceForDataDir(resolveProfileDataDirPaths(null, homeDir).dataDir);
}

/** Seed the shared store exactly as a CLI login would have left it. */
async function seedSignedInCredential(homeDir: string, lease: SeededLease): Promise<void> {
	await seedSignedInCredentialAt(resolveProfileDataDirPaths(null, homeDir).dataDir, lease);
}

/** Seed the store of an EXPLICIT data directory (the namespace-rooted variant). */
async function seedSignedInCredentialAt(dataDir: string, lease: SeededLease): Promise<void> {
	const namespace = namespaceForDataDir(dataDir);
	// `FileStore.put` reads the payload first, so drop a corrupted record
	// (this helper also serves as the "outage ends" repair).
	await rm(namespace.credentialPath, { force: true });
	const credential: StoredCredential = {
		schemaVersion: 1,
		accessToken: lease.accessToken,
		refreshToken: `refresh-${lease.generation}`,
		tokenType: 'Bearer',
		clientId: MCODE_OAUTH_CLIENT_ID,
		scopes: [...MCODE_OAUTH_SCOPES],
		audience: MCODE_OAUTH_AUDIENCE,
		expiresAtMs: Date.now() + SEEDED_VALIDITY_MS,
		generation: lease.generation,
		loginEpoch: 'epoch-1',
	};
	await new FileStore({ authHome: namespace.namespaceHome }).put(
		namespace.credentialKey,
		credential,
	);
	const state: AuthState = {
		schemaVersion: 2,
		status: 'authenticated',
		storeKind: 'file',
		clientId: MCODE_OAUTH_CLIENT_ID,
		scopes: [...MCODE_OAUTH_SCOPES],
		audience: MCODE_OAUTH_AUDIENCE,
		generation: lease.generation,
	};
	await writeFile(namespace.statePath, `${JSON.stringify(state)}\n`);
}

/** Break the credential record so store reads fail transiently (offline). */
async function corruptCredentialStore(homeDir: string): Promise<void> {
	await writeFile(join(profileNamespace(homeDir).namespaceHome, 'auth.json'), '{ corrupt');
}

describe('createProfileAuthSession refresh chain', () => {
	let homeDir: string | undefined;
	let session: LocalRuntimeAdapterAuthSession | undefined;
	let countLeaseFailures: () => number;

	beforeEach(() => {
		// Only the lease timer and the clock: microtasks, setImmediate and the
		// fs threadpool stay real so store I/O completes between advances.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const stderrSpy = vi.spyOn(process.stderr, 'write');
		countLeaseFailures = () =>
			stderrSpy.mock.calls.filter(([chunk]) => String(chunk).includes('auth-lease-unavailable'))
				.length;
	});

	afterEach(async () => {
		session?.dispose();
		session = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (homeDir) await rm(homeDir, { recursive: true, force: true });
		homeDir = undefined;
	});

	it('keeps the last lease and retries with backoff when a refresh fails transiently', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'mcoded-auth-lease-'));
		await seedSignedInCredential(homeDir, { accessToken: 'token-1', generation: 1 });
		session = createProfileAuthSession({
			env: { ...OFFLINE_ENDPOINTS },
			homeDir,
			profile: null,
		});
		expect(session).toBeDefined();

		// The initial lease is served straight from the store — no network.
		await session!.lease();
		expect(session!.authContextGetter()).toEqual({
			accessToken: 'token-1',
			loginEpoch: 'epoch-1',
		});

		// The store breaks mid-flight (corrupt record = transient failure: the
		// read fails before any refresh request). Pre-fix this dropped the lease
		// AND killed the chain; now the last known lease survives…
		await corruptCredentialStore(homeDir);
		await expect(session!.lease()).resolves.toBeUndefined();
		expect(session!.authContextGetter()).toEqual({
			accessToken: 'token-1',
			loginEpoch: 'epoch-1',
		});
		expect(countLeaseFailures()).toBe(1);

		// …and the retry ladder re-arms: first retry after 30 s (still broken),
		vi.advanceTimersByTime(30_000);
		await expect.poll(countLeaseFailures, { timeout: 2_000 }).toBe(2);
		expect(session!.authContextGetter()).toEqual({
			accessToken: 'token-1',
			loginEpoch: 'epoch-1',
		});

		// the second retry only after 60 s more (doubling backoff),
		vi.advanceTimersByTime(30_000);
		expect(vi.getTimerCount()).toBe(1);
		expect(countLeaseFailures()).toBe(2);
		vi.advanceTimersByTime(30_000);
		await expect.poll(countLeaseFailures, { timeout: 2_000 }).toBe(3);

		// and once the store heals (another owner refreshed it), the still-live
		// chain picks the fresh token up on the next scheduled retry.
		await seedSignedInCredential(homeDir, { accessToken: 'token-2', generation: 1 });
		vi.advanceTimersByTime(120_000);
		await expect.poll(() => session!.authContextGetter(), { timeout: 2_000 }).toEqual({
			accessToken: 'token-2',
			loginEpoch: 'epoch-1',
		});
		expect(countLeaseFailures()).toBe(3);

		// A recovered lease resets the ladder: the NEXT failure retries after
		// 30 s again, not after the doubled 240 s.
		await corruptCredentialStore(homeDir);
		await expect(session!.lease()).resolves.toBeUndefined();
		expect(countLeaseFailures()).toBe(4);
		vi.advanceTimersByTime(30_000);
		await expect.poll(countLeaseFailures, { timeout: 2_000 }).toBe(5);
	});

	it('drops the lease on signed-out failures but keeps retrying until a later login', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'mcoded-auth-lease-'));
		session = createProfileAuthSession({
			env: { ...OFFLINE_ENDPOINTS },
			homeDir,
			profile: null,
		});
		expect(session).toBeDefined();

		// Signed-out profile (empty store): degrade to `undefined` auth — the
		// documented behavior — but no longer forever.
		await expect(session!.lease()).resolves.toBeUndefined();
		expect(session!.authContextGetter()).toBeUndefined();
		expect(countLeaseFailures()).toBe(1);

		// The retry ladder stays armed: first re-attempt at 30 s…
		vi.advanceTimersByTime(29_999);
		expect(vi.getTimerCount()).toBe(1);
		expect(countLeaseFailures()).toBe(1);
		vi.advanceTimersByTime(1);
		await expect.poll(countLeaseFailures, { timeout: 2_000 }).toBe(2);

		// …and when the user signs in through the CLI into the same shared
		// store, the next retry picks the login up — no daemon restart.
		await seedSignedInCredential(homeDir, { accessToken: 'token-1', generation: 1 });
		vi.advanceTimersByTime(60_000);
		await expect.poll(() => session!.authContextGetter(), { timeout: 2_000 }).toEqual({
			accessToken: 'token-1',
			loginEpoch: 'epoch-1',
		});
		expect(countLeaseFailures()).toBe(2);
	});

	it('builds the namespace from the served dataDir, ignoring MINIMAX_PROFILE', async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'mcoded-auth-lease-'));
		// Two signed-in CLI stores in one home with DISTINCT tokens: the cedar
		// profile the session SERVES (`~/.minimax-cedar`) and the `other`
		// profile the env names — so the assertion tells the namespaces apart.
		const cedarDataDir = getPrimaryDataDirPath(homeDir, 'cedar');
		await seedSignedInCredentialAt(cedarDataDir, { accessToken: 'token-cedar', generation: 1 });
		await seedSignedInCredentialAt(getPrimaryDataDirPath(homeDir, 'other'), {
			accessToken: 'token-other',
			generation: 1,
		});
		session = createProfileAuthSession({
			env: { ...OFFLINE_ENDPOINTS, [PROFILE_ENV_VAR]: 'other' },
			homeDir,
			dataDir: cedarDataDir,
		});
		expect(session).toBeDefined();

		// The initial lease is served from the cedar store — the served
		// dataDir decides the namespace; the env profile is a log label at
		// most (pre-fix the env resolved the store to `other` → token-other).
		await session!.lease();
		expect(session!.authContextGetter()).toEqual({
			accessToken: 'token-cedar',
			loginEpoch: 'epoch-1',
		});
	});
});

// Keep real timers for the real socket and profile store. Inspect the lease at
// the moment the runtime host receives each lifecycle event.
it('synchronizes a running product daemon on login and logout', async () => {
	const homeDir = await realpath(await mkdtemp(join(tmpdir(), 'mcoded-auth-sync-')));
	const env = { HOME: homeDir, ...OFFLINE_ENDPOINTS };
	const notifications: Array<[string, string | undefined]> = [];
	let daemon: Awaited<ReturnType<typeof startProductDaemon>> | undefined;
	let window: Awaited<ReturnType<typeof createRemoteRuntimeHost>> | undefined;
	try {
		daemon = await startProductDaemon({
			env,
			homeDir,
			argv: ['--profile', 'default'],
			prepareMcodeTools: null,
			createHost: async (options) => ({
				dataDir: options.dataDir,
				cliService: { isGoalEnabled: () => false, watchEvents: () => [] },
				ready: Promise.resolve(),
				apiHost: { ensureBuiltinAgents: async () => {}, close: async () => {} },
				metricsClient: { close: async () => {} },
				notifyAuthContextChanged: (state: string) => {
					notifications.push([state, options.authContextGetter?.()?.accessToken]);
				},
			}) as unknown as CreatedLocalRuntimeHost,
		});
		window = await createRemoteRuntimeHost({ dataDir: '', profile: 'default', homeDir, environment: env });
		await window.ready;
		await seedSignedInCredential(homeDir, { accessToken: 'offline-1', generation: 1 });
		await window.notifyAuthContextChanged('authenticated');
		expect(notifications).toEqual([['authenticated', 'offline-1']]);

		await corruptCredentialStore(homeDir);
		await expect(window.notifyAuthContextChanged('authenticated')).rejects.toThrow('Unable to synchronize');
		expect(notifications).toHaveLength(1);

		await seedSignedInCredential(homeDir, { accessToken: 'offline-2', generation: 2 });
		const core = createProfileOAuthCore({ dataDir: daemon.dataDir, env });
		await core!.logout({ revoke: false });
		await window.notifyAuthContextChanged('logged_out');
		expect(notifications[1]).toEqual(['logged_out', undefined]);
	} finally {
		await window?.apiHost.close();
		await daemon?.stop();
		await rm(homeDir, { recursive: true, force: true });
	}
}, 30_000);
