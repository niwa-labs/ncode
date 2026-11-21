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
 * real, advancing clock.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
	type LocalRuntimeAdapterAuthSession,
} from '../src/local-runtime-adapter.js';

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

/**
 * Yield to the real event loop so the file store's threadpool I/O settles
 * after a timer-driven `lease()` ran under fake timers.
 *
 * Budget: a failing lease attempt is a chain of sequential fs hops, and the
 * signed-out family takes the full `CrossProcessAuthLock` round-trip
 * (mkdir/chmod/open/close, proper-lockfile acquire+release, two state reads)
 * before it can log. Measured on this repo (tsx repro against the real
 * oauth-core store): 12 setImmediate rounds for the corrupt-record path and
 * 24 for the signed-out path, so 12 rounds let the assertion sample the
 * spy before the retry's log line landed. 250 rounds is ~10x the measured
 * worst case; rounds are microsecond-scale, so this stays instant.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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
		await vi.advanceTimersByTimeAsync(30_000);
		await settle();
		expect(countLeaseFailures()).toBe(2);
		expect(session!.authContextGetter()).toEqual({
			accessToken: 'token-1',
			loginEpoch: 'epoch-1',
		});

		// the second retry only after 60 s more (doubling backoff),
		await vi.advanceTimersByTimeAsync(30_000);
		await settle();
		expect(countLeaseFailures()).toBe(2);
		await vi.advanceTimersByTimeAsync(30_000 + 1);
		await settle();
		expect(countLeaseFailures()).toBe(3);

		// and once the store heals (another owner refreshed it), the still-live
		// chain picks the fresh token up on the next scheduled retry.
		await seedSignedInCredential(homeDir, { accessToken: 'token-2', generation: 1 });
		await vi.advanceTimersByTimeAsync(120_000 + 1);
		await settle();
		expect(countLeaseFailures()).toBe(3);
		expect(session!.authContextGetter()).toEqual({
			accessToken: 'token-2',
			loginEpoch: 'epoch-1',
		});

		// A recovered lease resets the ladder: the NEXT failure retries after
		// 30 s again, not after the doubled 240 s.
		await corruptCredentialStore(homeDir);
		await expect(session!.lease()).resolves.toBeUndefined();
		expect(countLeaseFailures()).toBe(4);
		await vi.advanceTimersByTimeAsync(30_000);
		await settle();
		expect(countLeaseFailures()).toBe(5);
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
		await vi.advanceTimersByTimeAsync(29_999);
		await settle();
		expect(countLeaseFailures()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(countLeaseFailures()).toBe(2);

		// …and when the user signs in through the CLI into the same shared
		// store, the next retry picks the login up — no daemon restart.
		await seedSignedInCredential(homeDir, { accessToken: 'token-1', generation: 1 });
		await vi.advanceTimersByTimeAsync(60_000 + 1);
		await settle();
		expect(countLeaseFailures()).toBe(2);
		expect(session!.authContextGetter()).toEqual({
			accessToken: 'token-1',
			loginEpoch: 'epoch-1',
		});
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
