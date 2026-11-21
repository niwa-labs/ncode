/**
 * Liveness verdicts of the Runtime owner identity fence — the seam that decides
 * whether an orphaned durable Turn lease (owner `turn-lease:<pid>:<instance>`)
 * may be reconciled after the owner died.
 *
 * The critical case is PID REUSE: the owner Runtime is killed mid-Turn and the
 * restarted daemon inherits its pid. Bare `kill(pid, 0)` liveness then sees a
 * living process and would fence the dead owner's Session forever (every
 * turn-admitting stream.open refused 409 local_session_busy — the "stream
 * refused by the runtime" incident). The instance lease file records the
 * writer's process start token, so a lease written by a DIFFERENT process
 * generation under the same pid is provably dead; a same-generation lease
 * (two Runtime instances in one process, e.g. tests) and a token-less
 * (legacy / degraded-probe) lease keep the conservative alive verdict.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimeOwnerIdentity,
  type RuntimeOwnerIdentity,
} from './identity.js';
import { readProcessStartToken } from './process-start-time.js';
import { parseRuntimeOwnerLease, serializeRuntimeOwnerLease } from './runtime-owner-lease.js';

const PID = process.pid;
const OWNER_A = 'instanceaaaa';
const OWNER_B = 'instancebbbb';
const OWNER_C = 'instancecccc';

let dataDir: string | undefined;
const identities: RuntimeOwnerIdentity[] = [];
const foreignPidsThatLookAlive = new Set<number>();
const spawnedChildren: ChildProcess[] = [];

function alivePids(pid: number): boolean {
  return pid === PID || foreignPidsThatLookAlive.has(pid);
}

async function identity(instanceId: string): Promise<RuntimeOwnerIdentity> {
  if (!dataDir) dataDir = await mkdtemp(join(tmpdir(), 'runtime-owner-identity-'));
  const created = await createRuntimeOwnerIdentity({
    dataDir,
    pid: PID,
    instanceId,
    isProcessAlive: alivePids,
  });
  identities.push(created);
  return created;
}

function leasePath(instanceId: string): string {
  if (!dataDir) throw new Error('identity dir not created');
  return join(dataDir, 'v2', 'runtime-owner-leases', `${instanceId}.owner`);
}

async function recordedStartToken(instanceId: string): Promise<string | undefined> {
  const lease = parseRuntimeOwnerLease(await readFile(leasePath(instanceId), 'utf8'));
  return lease.format === 'structured' ? lease.startToken : undefined;
}

afterEach(async () => {
  for (const identity_ of identities.splice(0)) {
    await identity_.close().catch(() => undefined);
  }
  foreignPidsThatLookAlive.clear();
  for (const child of spawnedChildren.splice(0)) {
    child.kill();
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(resolve, 2_000).unref?.();
    });
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    dataDir = undefined;
  }
});

describe('runtime owner liveness verdicts', () => {
  it('a foreign lease under a recycled pid is dead when its start token is from another generation', async () => {
    const ownerA = await identity(OWNER_A);
    const ownerB = await identity(OWNER_B);
    const ownerId = ownerA.createOwnerId('turn-lease');

    // The platform probe must have worked for the token logic to be observable;
    // on a probe-less platform the fence degrades to bare-pid liveness.
    const tokenA = await recordedStartToken(OWNER_A);
    const tokenB = await recordedStartToken(OWNER_B);
    if (tokenA === undefined || tokenB === undefined) return;

    // Same process generation (equal tokens): a live sibling instance — alive.
    expect(ownerB.isOwnerAlive(ownerId)).toBe(true);

    // Another process generation recorded the lease under this pid: the
    // recorded owner is gone (pid recycled) — dead, so its locks reconcile.
    await writeFile(
      leasePath(OWNER_A),
      serializeRuntimeOwnerLease({ pid: PID, startToken: `${tokenB}:previous-generation` }),
    );
    expect(ownerB.isOwnerAlive(ownerId)).toBe(false);
  });

  it('a token-less foreign lease keeps the conservative bare-pid verdict', async () => {
    const ownerA = await identity(OWNER_A);
    const ownerB = await identity(OWNER_B);
    const ownerId = ownerA.createOwnerId('turn-lease');

    // The pre-token lease shape (bare pid line only) — legacy writer.
    await writeFile(leasePath(OWNER_A), `${String(PID)}\n`);
    expect(ownerB.isOwnerAlive(ownerId)).toBe(true);
  });

  it('a foreign lease under a live foreign pid stays alive, under a dead pid is dead', async () => {
    const ownerA = await identity(OWNER_A);
    const ownerB = await identity(OWNER_B);

    const FOREIGN_ALIVE = 424_242;
    const FOREIGN_DEAD = 424_243;
    foreignPidsThatLookAlive.add(FOREIGN_ALIVE);

    // Foreign-pid owner ids naming the EXISTING instance lease of owner A.
    expect(ownerB.isOwnerAlive(`turn-lease:${FOREIGN_ALIVE}:${OWNER_A}.op`)).toBe(true);
    expect(ownerB.isOwnerAlive(`turn-lease:${FOREIGN_DEAD}:${OWNER_A}.op`)).toBe(false);
  });

  it('an owner id that does not parse stays an unknown (undefined) verdict', async () => {
    const ownerB = await identity(OWNER_B);
    expect(ownerB.isOwnerAlive('turn-lease:not-a-pid:x')).toBe(undefined);
    expect(ownerB.isOwnerAlive('totally-unrelated')).toBe(undefined);
  });

  // The FOREIGN-pid half of the fence (opus review bug 10): the dead owner's
  // pid was recycled by an unrelated LIVE process (not this Runtime), so bare
  // pid liveness alone would fence the lease forever. The lease records the
  // dead generation's token; boot recovery snapshots the current holder's
  // token for every pid named by a lease present at boot; the mismatch proves
  // the recorded owner gone.
  it('a foreign lease whose pid an unrelated live process reused is dead (boot token mismatch)', async () => {
    // A real live foreign process: its pid has a real, readable start token.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)']);
    spawnedChildren.push(child);
    await new Promise<void>((resolve) => (child.pid !== undefined ? resolve() : child.once('spawn', () => resolve())));
    expect(child.pid).toBeDefined();
    const foreignPid = child.pid as number;
    const holderToken = (await readProcessStartToken(foreignPid)).token;
    // Degrade like the sibling tests: without a platform probe the fence keeps
    // bare-pid liveness, so nothing below is observable.
    if (holderToken === undefined) return;

    // The foreign lease pre-dates the boot below and records a DIFFERENT
    // generation under the same pid (the dead original owner).
    dataDir ??= await mkdtemp(join(tmpdir(), 'runtime-owner-identity-'));
    await mkdir(join(dataDir, 'v2', 'runtime-owner-leases'), { recursive: true });
    await writeFile(
      leasePath(OWNER_C),
      serializeRuntimeOwnerLease({ pid: foreignPid, startToken: `${holderToken}:previous-generation` }),
    );
    foreignPidsThatLookAlive.add(foreignPid);

    // Boots AFTER the lease exists, so its boot snapshot covers foreignPid.
    const ownerB = await identity(OWNER_B);
    expect(ownerB.isOwnerAlive(`turn-lease:${String(foreignPid)}:${OWNER_C}.op`)).toBe(false);

    // Same generation (the lease rewritten by the current holder): the
    // conservative alive verdict returns.
    await writeFile(
      leasePath(OWNER_C),
      serializeRuntimeOwnerLease({ pid: foreignPid, startToken: holderToken }),
    );
    expect(ownerB.isOwnerAlive(`turn-lease:${String(foreignPid)}:${OWNER_C}.op`)).toBe(true);
  });
});
