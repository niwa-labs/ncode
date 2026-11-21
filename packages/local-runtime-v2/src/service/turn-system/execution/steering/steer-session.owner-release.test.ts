/**
 * Owner-only release + input-before-provider barrier (verdict 09 §1.2/§1.6,
 * wave 2) on the live `createSteerSessionService`:
 *
 * - an owner steer delivered to an ACTIVE Turn commits the durable accept,
 *   then ENQUEUES the input for the next steering drain, and ONLY THEN runs
 *   the committed-steer release — the exact §1.6 order (accept → input
 *   available → release), with the release intent noted for late task-wait
 *   registrations;
 * - machine deliveries through the same ingress (background-task completion,
 *   cron, thread-goal, greeting) never release a foreground wait (§1.2);
 * - a replayed owner steer re-runs the idempotent release pass (a failed
 *   release is retried) while still answering duplicate — never a second
 *   delivery;
 * - a failed release after a successful enqueue surfaces the control-plane
 *   error and keeps the receipt reserved (the input WAS delivered; §1.6).
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import { createSteerSessionService, isOwnerSteeringDelivery } from './steer-session.service.js';
import type { SteerDelegationSteering } from './steer-session.service.js';
import type { SteerSessionInput } from '../../contracts.js';
import type { TurnIngressReceipt } from '../../admission-contracts.js';

function receiptsStore() {
  const receipts = new Map<string, TurnIngressReceipt>();
  const byKey = (sessionId: string, clientRequestId: string) => `${sessionId}\u0000${clientRequestId}`;
  return {
    receipts,
    findSteeringReceipt: vi.fn(
      async (input: { readonly sessionId: string; readonly clientRequestId: string }) =>
        receipts.get(byKey(input.sessionId, input.clientRequestId)),
    ),
    reserveSteeringReceipt: vi.fn(
      async (input: {
        readonly sessionId: string;
        readonly clientRequestId: string;
        readonly turnId: string;
      }) => {
        const key = byKey(input.sessionId, input.clientRequestId);
        const existing = receipts.get(key);
        if (existing) return { status: 'duplicate' as const, turnId: existing.turnId };
        receipts.set(key, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          inputDigest: 'sha256:test',
          acceptedSequence: 1,
        });
        return { status: 'reserved' as const };
      },
    ),
    releaseSteeringReceipt: vi.fn(
      async (input: { readonly sessionId: string; readonly clientRequestId: string; readonly turnId: string }) => {
        const key = byKey(input.sessionId, input.clientRequestId);
        if (receipts.get(key)?.turnId === input.turnId) receipts.delete(key);
      },
    ),
  };
}

/** Delegation steering double recording the exact call order of the seam. */
function delegationDouble(options: { failRelease?: boolean } = {}): {
  double: SteerDelegationSteering;
  calls: string[];
} {
  const calls: string[] = [];
  const result = {
    calls,
    double: {
      acceptOwnerInput: vi.fn(async (input: { conversationId: string }) => {
        calls.push(`accept:${input.conversationId}`);
        return { status: 'committed', inputEntryId: 'e1', commitSeq: 1, submissionId: 's1' };
      }),
      onCommittedSteer: vi.fn(async (steer: { parentConversationId: string }) => {
        calls.push(`release:${steer.parentConversationId}`);
        if (options.failRelease) throw new Error('seam storage unavailable');
        return null;
      }),
      noteOwnerReleaseIntent: vi.fn((conversationId: string, turnId: string) => {
        calls.push(`intent:${conversationId}:${turnId}`);
      }),
    },
  };
  return result;
}

function steerInput(extra: Partial<SteerSessionInput>): SteerSessionInput {
  return {
    sessionId: 'owner-session',
    input: { text: 'change course' },
    provenance: { source: 'api', routingFingerprint: 'owner-release-test' },
    producerId: 'composer-steer',
    idempotencyKey: 'req-1',
    ...extra,
  };
}

async function activeTurnService(
  delegation?: SteerDelegationSteering,
): Promise<{ service: ReturnType<typeof createSteerSessionService>; receipts: ReturnType<typeof receiptsStore>; steerActiveTurn: ReturnType<typeof vi.fn> }> {
  const receipts = receiptsStore();
  const steerActiveTurn = vi.fn(async () => ({ status: 'accepted' as const, turnId: 'turn-1' }));
  const service = createSteerSessionService({
    turns: { activeTurnId: () => 'turn-1', steerActiveTurn },
    activation: { execute: vi.fn(async () => { throw new Error('must not activate'); }) },
    receipts,
    ...(delegation ? { delegationSteering: delegation } : {}),
  });
  return { service, receipts, steerActiveTurn };
}

describe('owner-only release with the §1.6 input-before-provider barrier', () => {
  it('owner steer: accept → enqueue → note intent → release, in that order', async () => {
    const { double, calls } = delegationDouble();
    const receipts = receiptsStore();
    const steerActiveTurn = vi.fn(async () => ({ status: 'accepted' as const, turnId: 'turn-1' }));
    const service = createSteerSessionService({
      turns: { activeTurnId: () => 'turn-1', steerActiveTurn },
      activation: { execute: vi.fn(async () => { throw new Error('must not activate'); }) },
      receipts,
      delegationSteering: double,
    });
    const result = await service.steer(steerInput({}));

    expect(result).toEqual({ delivered: true, mode: 'steered', turnId: 'turn-1' });
    expect(calls).toEqual([
      'accept:owner-session',
      // The input is enqueued for the next drain BEFORE the release: the
      // parked task tool cannot return until the release, so the next
      // provider request necessarily carries the message and the note.
      'intent:owner-session:turn-1',
      'release:owner-session',
    ]);
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('machine deliveries never release: background-task completion, cron, thread-goal, greeting', async () => {
    for (const [producerId, source] of [
      ['background-task-delivery', 'background-task'],
      ['cron:job-1', 'cron'],
      ['thread-goal-driver', 'thread-goal'],
      ['greeting-sender', 'greeting'],
    ] as const) {
      const { double, calls } = delegationDouble();
      const { service } = await activeTurnService(double);

      const result = await service.steer(steerInput({ producerId, provenance: { source, routingFingerprint: 'machine' } }));

      expect(result).toEqual({ delivered: true, mode: 'steered', turnId: 'turn-1' });
      // The durable accept still records the delivery; NO release reaction.
      expect(calls).toEqual(['accept:owner-session']);
    }
  });

  it('isOwnerSteeringDelivery: trusted user producers and user-facing sources pass, machine routes fail', () => {
    expect(isOwnerSteeringDelivery(steerInput({}))).toBe(true);
    expect(
      isOwnerSteeringDelivery(steerInput({ producerId: 'mcode' })),
    ).toBe(true);
    expect(
      isOwnerSteeringDelivery(steerInput({ producerId: 'queue-immediate-send' })),
    ).toBe(true);
    expect(
      isOwnerSteeringDelivery(
        steerInput({ producerId: 'background-task-delivery', provenance: { source: 'background-task', routingFingerprint: 'x' } }),
      ),
    ).toBe(false);
    expect(
      isOwnerSteeringDelivery(
        steerInput({ producerId: 'cron:job', provenance: { source: 'cron', routingFingerprint: 'x' } }),
      ),
    ).toBe(false);
    expect(
      isOwnerSteeringDelivery(
        steerInput({ producerId: 'channel:feishu', provenance: { source: 'channel:feishu', routingFingerprint: 'x' } }),
      ),
    ).toBe(true);
  });

  it('a replayed owner steer answers duplicate and re-runs the idempotent release (retry)', async () => {
    const { double, calls } = delegationDouble();
    const { service, receipts, steerActiveTurn } = await activeTurnService(double);

    // The pin carries the receipt identity, so the replay resolves as a
    // duplicate instead of a second delivery (same as the daemon ACP steer).
    await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));
    const firstCount = steerActiveTurn.mock.calls.length;
    calls.length = 0;

    const replay = await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    expect(replay).toEqual({ delivered: true, mode: 'duplicate', turnId: 'turn-1' });
    expect(steerActiveTurn.mock.calls.length).toBe(firstCount);
    // The retry re-runs the SAME idempotent pass — never a second delivery.
    expect(calls).toEqual([
      'accept:owner-session',
      'intent:owner-session:turn-1',
      'release:owner-session',
    ]);
    expect(receipts.releaseSteeringReceipt).not.toHaveBeenCalled();
  });

  it('a failed release after a successful enqueue throws visibly and keeps the receipt reserved', async () => {
    const { double: failing } = delegationDouble({ failRelease: true });
    const { service, receipts } = await activeTurnService(failing);

    await expect(service.steer(steerInput({}))).rejects.toThrow('seam storage unavailable');

    // The input WAS delivered to the Turn, so the receipt stays reserved: a
    // replay answers duplicate and re-runs the release (previous test).
    expect(receipts.releaseSteeringReceipt).not.toHaveBeenCalled();
  });
});
