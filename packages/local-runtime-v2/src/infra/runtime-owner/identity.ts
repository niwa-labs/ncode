import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';

import { readProcessStartToken } from './process-start-time.js';
import {
  parseRuntimeOwnerLease,
  serializeRuntimeOwnerLease,
} from './runtime-owner-lease.js';

const DEFAULT_RUNTIME_OWNER_STALE_MS = 10_000;
const OWNER_DIRECTORY = join('v2', 'runtime-owner-leases');
const OWNER_KINDS = new Set<RuntimeOwnerKind>([
  'turn-lease',
  'session-delete',
  'queue-claim',
  'background-task',
]);

type RuntimeOwnerKind = 'turn-lease' | 'session-delete' | 'queue-claim' | 'background-task';

export interface RuntimeOwnerIdentity {
  readonly instanceId: string;
  readonly recoveryRetryMs: number;
  createOwnerId(kind: RuntimeOwnerKind): string;
  ownsOwnerId(ownerId: string): boolean;
  isOwnerAlive(ownerId: string): boolean | undefined;
  onCompromised(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

type RuntimeOwnerLeaseState = 'active' | 'stale' | 'missing';

interface RuntimeOwnerLivenessOptions {
  readonly currentPid: number;
  readonly currentInstanceId: string;
  /**
   * The start token of THIS process, when the platform probe worked. It is the
   * pivot of the PID-reuse verdict below: two leases recorded under one pid are
   * the same process exactly when their tokens match.
   */
  readonly currentStartToken?: string;
  /**
   * Start tokens of FOREIGN pids recorded in lease files at boot recovery,
   * snapshotted once per boot (the probe spawns `ps` / reads `/proc`, far too
   * heavy for the per-ownerId liveness path). A pid absent from the map was
   * not recoverable at boot — its verdict stays conservative bare-pid
   * liveness.
   */
  readonly bootPidTokens: ReadonlyMap<number, string | undefined>;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly getInstanceLeaseState: (instanceId: string) => RuntimeOwnerLeaseState;
  /** The structured start token recorded in a foreign instance lease, if any. */
  readonly getForeignLeaseStartToken: (instanceId: string) => string | undefined;
}

function formatRuntimeOwnerId(
  kind: RuntimeOwnerKind,
  pid: number,
  instanceId: string,
  operationId: string,
): string {
  return `${kind}:${String(pid)}:${instanceId}.${operationId}`;
}

function createRuntimeOwnerLiveness(
  options: RuntimeOwnerLivenessOptions,
): (ownerId: string) => boolean | undefined {
  return (ownerId) => {
    const parsed = parseOwnerId(ownerId);
    if (!parsed) return ownerId.startsWith('session-delete:') ? false : undefined;
    if (!parsed.instanceId) return options.isProcessAlive(parsed.pid);
    const leaseState = options.getInstanceLeaseState(parsed.instanceId);
    const currentInstance =
      parsed.pid === options.currentPid && parsed.instanceId === options.currentInstanceId;
    // Compromise revokes authority, but does not prove that this process finished draining.
    if (currentInstance) return leaseState !== 'missing';
    if (leaseState === 'missing') return false;
    // PID reuse (the owner died and a new process took its pid — the restart
    // case where the new Runtime inherits the old daemon's pid, or an
    // UNRELATED foreign process recycling it): bare `kill(pid, 0)` liveness
    // would fence the dead owner's orphaned work forever. The recorded lease
    // token decides: a foreign instance whose lease was written by a DIFFERENT
    // process generation than the one currently holding the pid is gone, so
    // its locks must stay recoverable. The current holder's token is this
    // process's own (`currentStartToken`) when the pid is ours, and the
    // boot-recovery snapshot (`bootPidTokens`) for any other pid. A
    // same-generation lease (equal tokens — e.g. two Runtime instances inside
    // one process) and a token-less / unsnapshotted (legacy, degraded-probe)
    // lease keep the conservative verdict.
    const holderToken =
      parsed.pid === options.currentPid
        ? options.currentStartToken
        : options.bootPidTokens.get(parsed.pid);
    if (holderToken !== undefined) {
      const recordedToken = options.getForeignLeaseStartToken(parsed.instanceId);
      if (recordedToken !== undefined && recordedToken !== holderToken) return false;
    }
    if (!options.isProcessAlive(parsed.pid)) return false;
    // A delayed heartbeat is not proof that this exact foreign owner died.
    // Its process must close the lease or exit before another Runtime may recover its work.
    return true;
  };
}

export async function createRuntimeOwnerIdentity(options: {
  readonly dataDir: string;
  readonly pid?: number;
  readonly instanceId?: string;
  readonly staleMs?: number;
  /** @internal Direct-module test seam for deterministic foreign-process liveness. */
  readonly isProcessAlive?: (pid: number) => boolean;
}): Promise<RuntimeOwnerIdentity> {
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? randomUUID();
  const staleMs = Math.max(2_000, Math.floor(options.staleMs ?? DEFAULT_RUNTIME_OWNER_STALE_MS));
  const ownerDirectory = join(options.dataDir, OWNER_DIRECTORY);
  const targetPath = ownerLeasePath(ownerDirectory, instanceId);
  await mkdir(ownerDirectory, { recursive: true });
  // The start token lets the generation fence tell this exact process apart from a later
  // process that reuses its PID. It is best-effort by design: `readProcessStartToken`
  // degrades to `undefined` instead of throwing, and a lease without a token is read back
  // as the historical PID-only lease rather than blocking the Runtime from starting.
  const { token: startToken } = await readProcessStartToken(pid);
  await writeFile(targetPath, serializeRuntimeOwnerLease({ pid, startToken }), {
    flag: 'wx',
    mode: 0o600,
  });
  const compromiseListeners = new Set<(error: Error) => void>();
  let compromise: Error | undefined;
  let closed = false;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(targetPath, {
      realpath: false,
      stale: staleMs,
      update: Math.max(1_000, Math.floor(staleMs / 3)),
      onCompromised: (error) => markCompromised(error),
    });
  } catch (error) {
    await rm(targetPath, { force: true });
    throw error;
  }

  const isOwnerAlive = createRuntimeOwnerLiveness({
    currentPid: pid,
    currentInstanceId: instanceId,
    ...(startToken !== undefined ? { currentStartToken: startToken } : {}),
    // The foreign-pid half of the PID-reuse fence (opus review bug 10): the
    // lease files present at boot are exactly the recovery set, so their
    // recorded pids' CURRENT generation tokens are snapshotted once here —
    // never on the per-ownerId liveness path — letting isOwnerAlive prove a
    // foreign lease dead even when an unrelated LIVE process now holds its pid.
    bootPidTokens: await snapshotBootPidTokens(ownerDirectory, pid),
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    getInstanceLeaseState: (candidate) => {
      if (candidate === instanceId) {
        if (closed) return 'missing';
        return compromise ? 'stale' : 'active';
      }
      if (!validInstanceId(candidate)) return 'missing';
      const candidatePath = ownerLeasePath(ownerDirectory, candidate);
      try {
        statSync(candidatePath);
      } catch (error) {
        return errorCode(error) === 'ENOENT' ? 'missing' : 'stale';
      }
      try {
        return lockfile.checkSync(candidatePath, {
          realpath: false,
          stale: staleMs,
        })
          ? 'active'
          : 'stale';
      } catch {
        return 'stale';
      }
    },
    getForeignLeaseStartToken: (candidate) => {
      if (!validInstanceId(candidate)) return undefined;
      try {
        const text = readFileSync(ownerLeasePath(ownerDirectory, candidate), 'utf8');
        const lease = parseRuntimeOwnerLease(text);
        return lease.format === 'structured' ? lease.startToken : undefined;
      } catch {
        // An unreadable lease stays conservative: the pid verdict decides below.
        return undefined;
      }
    },
  });
  let closePromise: Promise<void> | undefined;

  function markCompromised(error: Error): void {
    if (closed || compromise) return;
    compromise = runtimeOwnerCompromiseError(error);
    for (const listener of compromiseListeners) notifyCompromise(listener, compromise);
  }

  return {
    instanceId,
    recoveryRetryMs: staleMs + 100,
    createOwnerId: (kind) => {
      assertOwnerIdentityActive(closed, compromise);
      return formatRuntimeOwnerId(kind, pid, instanceId, randomUUID());
    },
    ownsOwnerId: (ownerId) =>
      !closed && !compromise && ownerMatchesRuntime(ownerId, pid, instanceId),
    isOwnerAlive,
    onCompromised: (listener) => {
      if (compromise) {
        notifyCompromise(listener, compromise);
        return () => undefined;
      }
      compromiseListeners.add(listener);
      return () => compromiseListeners.delete(listener);
    },
    close: () => {
      closePromise ??= (async () => {
        closed = true;
        compromiseListeners.clear();
        try {
          await release?.();
        } catch {
          // The exact owner is already marked closed; stale-lock cleanup may finish later.
        }
        await rm(targetPath, { force: true });
      })();
      return closePromise;
    },
  };
}

export function createProcessLocalRuntimeOwnerIdentity(
  options: {
    readonly pid?: number;
    readonly instanceId?: string;
  } = {},
): RuntimeOwnerIdentity {
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? randomUUID();
  let closed = false;
  return {
    instanceId,
    recoveryRetryMs: DEFAULT_RUNTIME_OWNER_STALE_MS,
    createOwnerId: (kind) => {
      assertOwnerIdentityActive(closed);
      return formatRuntimeOwnerId(kind, pid, instanceId, randomUUID());
    },
    ownsOwnerId: (ownerId) => !closed && ownerMatchesRuntime(ownerId, pid, instanceId),
    isOwnerAlive: createRuntimeOwnerLiveness({
      currentPid: pid,
      currentInstanceId: instanceId,
      isProcessAlive,
      bootPidTokens: new Map(),
      getInstanceLeaseState: (candidate) =>
        candidate === instanceId && !closed ? 'active' : 'missing',
      // Process-local identities keep no lease files; foreign instances are
      // 'missing' above, so this reader is never consulted.
      getForeignLeaseStartToken: () => undefined,
    }),
    onCompromised: () => () => undefined,
    close: async () => {
      closed = true;
      void closed;
    },
  };
}

/**
 * Boot-recovery snapshot of the process-generation tokens of every FOREIGN pid
 * recorded in an existing owner lease (`snapshotBootPidTokens`'s caller): the
 * pids named by leases present at boot are the recovery set, and their current
 * tokens are what later lets `isOwnerAlive` prove a lease dead when an
 * unrelated live process has since recycled its pid. Never throws — a pid
 * whose probe fails simply maps to `undefined` (the conservative verdict).
 */
async function snapshotBootPidTokens(
  ownerDirectory: string,
  selfPid: number,
): Promise<Map<number, string | undefined>> {
  const tokens = new Map<number, string | undefined>();
  let names: readonly string[];
  try {
    names = readdirSync(ownerDirectory);
  } catch {
    return tokens;
  }
  const pids = new Set<number>();
  for (const name of names) {
    if (!name.endsWith('.owner')) continue;
    try {
      const lease = parseRuntimeOwnerLease(readFileSync(join(ownerDirectory, name), 'utf8'));
      // Only structured leases carry a comparable token, so only their pids
      // are worth a probe; our own pid is judged via `currentStartToken`.
      if (lease.format !== 'structured' || lease.pid === selfPid) continue;
      pids.add(lease.pid);
    } catch {
      continue;
    }
  }
  await Promise.all(
    [...pids].map(async (pid) => {
      const { token } = await readProcessStartToken(pid);
      tokens.set(pid, token);
    }),
  );
  return tokens;
}

function assertOwnerIdentityActive(closed: boolean, compromise?: Error): void {
  if (compromise) throw compromise;
  if (closed) throw new Error('Runtime owner identity is closed');
}

function runtimeOwnerCompromiseError(cause: Error): Error {
  const code = errorCode(cause) ?? 'ECOMPROMISED';
  return Object.assign(new Error('Runtime owner lease is compromised', { cause }), { code });
}

function notifyCompromise(listener: (error: Error) => void, error: Error): void {
  try {
    listener(error);
  } catch {
    // One observer cannot prevent other owners from entering fail-closed shutdown.
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function ownerMatchesRuntime(ownerId: string, pid: number, instanceId: string): boolean {
  const parsed = parseOwnerId(ownerId);
  return parsed?.pid === pid && parsed.instanceId === instanceId;
}

function parseOwnerId(ownerId: string):
  | {
      readonly kind: RuntimeOwnerKind;
      readonly pid: number;
      readonly instanceId?: string;
    }
  | undefined {
  const match = /^([^:]+):([1-9]\d*):([^:]+)$/.exec(ownerId);
  if (!match) return undefined;
  const kind = match[1] as RuntimeOwnerKind;
  if (!OWNER_KINDS.has(kind)) return undefined;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid)) return undefined;
  const token = match[3] ?? '';
  const separator = token.indexOf('.');
  if (separator < 1) return { kind, pid };
  const instanceId = token.slice(0, separator);
  return validInstanceId(instanceId) ? { kind, pid, instanceId } : undefined;
}

function ownerLeasePath(ownerDirectory: string, instanceId: string): string {
  if (!validInstanceId(instanceId)) throw new TypeError('Invalid Runtime owner instance id');
  return join(ownerDirectory, `${instanceId}.owner`);
}

function validInstanceId(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
