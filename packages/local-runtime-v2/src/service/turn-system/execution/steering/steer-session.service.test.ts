import { describe, expect, it, vi } from 'vitest';

import { createSteerSessionService } from './steer-session.service.js';
import type { SteerSessionInput } from '../../contracts.js';
import type { TurnIngressReceipt } from '../../admission-contracts.js';

/**
 * The daemon-mode ACP steer regression: the caller pins the Turn it may join
 * with `expectActiveTurnId` (data, not the in-process `preDelivery` callback,
 * which a JSON wire silently drops). The service must enforce the pin where
 * the active Turn lives and never activate a fresh Turn on a miss.
 */
describe('createSteerSessionService expectActiveTurnId (wire-safe Turn pin)', () => {
  it('delivers to the pinned active Turn and reserves the durable receipt', async () => {
    const steerActiveTurn = vi.fn(async () => ({ status: 'accepted', turnId: 'turn-1' }));
    const reserveSteeringReceipt = vi.fn(async () => ({ status: 'reserved' }));
    const service = createSteerSessionService({
      turns: { activeTurnId: () => 'turn-1', steerActiveTurn },
      activation: { execute: vi.fn(async () => { throw new Error('must not activate'); }) },
      receipts: {
        findSteeringReceipt: vi.fn(async () => undefined),
        reserveSteeringReceipt,
        releaseSteeringReceipt: vi.fn(async () => undefined),
      },
    });

    const result = await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    expect(result).toEqual({ delivered: true, mode: 'steered', turnId: 'turn-1' });
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
    // The pin carries the same at-most-once contract as the preDelivery hook.
    expect(reserveSteeringReceipt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      clientRequestId: 'steer:mcode-acp\u0000req-1',
      turnId: 'turn-1',
    });
  });

  it('refuses without activating when another Turn is active', async () => {
    const steerActiveTurn = vi.fn(async () => ({ status: 'accepted', turnId: 'turn-2' }));
    const activation = { execute: vi.fn(async () => { throw new Error('must not activate'); }) };
    const releaseSteeringReceipt = vi.fn(async () => undefined);
    const service = createSteerSessionService({
      turns: { activeTurnId: () => 'turn-2', steerActiveTurn },
      activation,
      receipts: {
        findSteeringReceipt: vi.fn(async () => undefined),
        reserveSteeringReceipt: vi.fn(async () => ({ status: 'reserved' })),
        releaseSteeringReceipt,
      },
    });

    const result = await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    expect(result).toEqual({ delivered: false, reason: 'active-turn' });
    expect(steerActiveTurn).not.toHaveBeenCalled();
    expect(activation.execute).not.toHaveBeenCalled();
  });

  it('refuses without activating when no Turn is active', async () => {
    const activation = { execute: vi.fn(async () => { throw new Error('must not activate'); }) };
    const service = createSteerSessionService({
      turns: {
        activeTurnId: () => undefined,
        steerActiveTurn: vi.fn(async () => ({ status: 'not-running' })),
      },
      activation,
      receipts: {
        findSteeringReceipt: vi.fn(async () => undefined),
        reserveSteeringReceipt: vi.fn(async () => ({ status: 'reserved' })),
        releaseSteeringReceipt: vi.fn(async () => undefined),
      },
    });

    const result = await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    expect(result).toEqual({ delivered: false, reason: 'active-turn' });
    expect(activation.execute).not.toHaveBeenCalled();
  });

  it('still activates for ordinary steers that do not pin a Turn', async () => {
    const service = createSteerSessionService({
      turns: {
        activeTurnId: () => undefined,
        steerActiveTurn: vi.fn(async () => ({ status: 'not-running' })),
      },
      activation: {
        execute: vi.fn(async () => ({
          accepted: true as const,
          turnId: 'turn-new',
          acceptedAtMs: 1,
          completion: new Promise(() => undefined),
        })),
      },
      receipts: {
        findSteeringReceipt: vi.fn(async () => undefined),
        reserveSteeringReceipt: vi.fn(async () => ({ status: 'reserved' })),
        releaseSteeringReceipt: vi.fn(async () => undefined),
      },
    });

    const result = await service.steer(steerInput({}));

    expect(result).toMatchObject({ delivered: true, mode: 'activated', turnId: 'turn-new' });
  });
});

/**
 * The durable receipt is the AUTHORITATIVE answer to a replayed
 * clientRequestId: the original delivery already happened, so the replay gets
 * `duplicate` with the ORIGINAL turnId — never a second delivery, never a
 * renamed Turn — regardless of what is (or is not) active now. The
 * `receiptLookupOnly` probe answers a replay from the receipt alone and can
 * neither deliver content nor activate a Turn.
 */
describe('createSteerSessionService durable steering receipts (replay authority)', () => {
  it('answers a replayed key as duplicate with the ORIGINAL turnId while the same Turn is active', async () => {
    const { receipts, service, steerActiveTurn } = harness({
      activeTurnId: 'turn-1',
      deliveredTurnId: 'turn-1',
    });

    const result = await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));
    expect(result).toEqual({ delivered: true, mode: 'steered', turnId: 'turn-1' });

    const replay = await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));
    expect(replay).toEqual({ delivered: true, mode: 'duplicate', turnId: 'turn-1' });
    // Exactly ONE actual delivery; the lookup-answered replay never even
    // reaches the reservation seam again.
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
    expect(receipts.reserveSteeringReceipt).toHaveBeenCalledTimes(1);
  });

  it('answers a replay after its Turn finished and no Turn is active with the ORIGINAL turnId', async () => {
    let activeTurnId: string | undefined = 'turn-1';
    const { service, steerActiveTurn } = harness({
      activeTurnId: () => activeTurnId,
      deliveredTurnId: 'turn-1',
    });
    await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    activeTurnId = undefined;
    const replay = await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    expect(replay).toEqual({ delivered: true, mode: 'duplicate', turnId: 'turn-1' });
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('answers a replay after a LATER Turn became active with the ORIGINAL turnId, not the current one', async () => {
    let activeTurnId = 'turn-1';
    const { service, steerActiveTurn } = harness({
      activeTurnId: () => activeTurnId,
      deliveredTurnId: 'turn-1',
    });
    await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    activeTurnId = 'turn-2';
    // The caller pins the Turn it SEES now; the receipt still wins for a
    // replayed key and reports the Turn the steer was actually delivered to.
    const replay = await service.steer(steerInput({ expectActiveTurnId: 'turn-2' }));

    expect(replay).toEqual({ delivered: true, mode: 'duplicate', turnId: 'turn-1' });
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('fixates the replay contract for a repeated key with a DIFFERENT payload', async () => {
    const { service, steerActiveTurn } = harness({
      activeTurnId: 'turn-1',
      deliveredTurnId: 'turn-1',
    });
    await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    // Current pinned behaviour: the receipt is keyed by producer + request id
    // only, so a different text under the same key is answered as the SAME
    // delivery — the new content is NOT delivered anywhere.
    const replay = await service.steer({
      ...steerInput({ expectActiveTurnId: 'turn-1' }),
      input: { text: 'completely different steering text' },
    });

    expect(replay).toEqual({ delivered: true, mode: 'duplicate', turnId: 'turn-1' });
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
    expect(steerActiveTurn.mock.calls[0]?.[0]?.message?.message?.text).not.toBe(
      'completely different steering text',
    );
  });

  it('settles two CONCURRENT replays of one key into one delivery plus one duplicate', async () => {
    const { service, steerActiveTurn, receipts } = harness({
      activeTurnId: 'turn-1',
      deliveredTurnId: 'turn-1',
    });

    const [first, second] = await Promise.all([
      service.steer(steerInput({ expectActiveTurnId: 'turn-1' })),
      service.steer(steerInput({ expectActiveTurnId: 'turn-1' })),
    ]);

    const results = [first, second].sort((left, right) =>
      left.mode === 'steered' ? -1 : right.mode === 'steered' ? 1 : 0,
    );
    expect(results[0]).toEqual({ delivered: true, mode: 'steered', turnId: 'turn-1' });
    expect(results[1]).toEqual({ delivered: true, mode: 'duplicate', turnId: 'turn-1' });
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
    // The losing concurrent replay never compensates the winner's receipt.
    expect(receipts.releaseSteeringReceipt).not.toHaveBeenCalled();
  });

  it('receiptLookupOnly answers from the receipt alone and never delivers or activates', async () => {
    const steerActiveTurn = vi.fn(async () => ({ status: 'accepted', turnId: 'turn-9' }));
    const activation = { execute: vi.fn(async () => { throw new Error('must not activate'); }) };
    const receipts = createReceipts();
    receipts.seed('session-1', 'steer:mcode-acp\u0000req-1', 'turn-1');
    const service = createSteerSessionService({
      turns: { activeTurnId: () => 'turn-2', steerActiveTurn },
      activation,
      receipts,
    });

    const result = await service.steer(steerInput({ receiptLookupOnly: true }));

    // Another Turn IS active, but a read-only probe never joins it: the
    // receipt answers with the Turn the steer was originally delivered to.
    expect(result).toEqual({ delivered: true, mode: 'duplicate', turnId: 'turn-1' });
    expect(steerActiveTurn).not.toHaveBeenCalled();
    expect(activation.execute).not.toHaveBeenCalled();
    expect(receipts.reserveSteeringReceipt).not.toHaveBeenCalled();
  });

  it('receiptLookupOnly without a receipt refuses without delivering, activating or reserving', async () => {
    const steerActiveTurn = vi.fn(async () => ({ status: 'accepted', turnId: 'turn-2' }));
    const activation = { execute: vi.fn(async () => { throw new Error('must not activate'); }) };
    const receipts = createReceipts();
    const service = createSteerSessionService({
      turns: { activeTurnId: () => 'turn-2', steerActiveTurn },
      activation,
      receipts,
    });

    const result = await service.steer(steerInput({ receiptLookupOnly: true }));

    expect(result).toEqual({ delivered: false, reason: 'active-turn' });
    expect(steerActiveTurn).not.toHaveBeenCalled();
    expect(activation.execute).not.toHaveBeenCalled();
    expect(receipts.reserveSteeringReceipt).not.toHaveBeenCalled();
  });

  it('receiptLookupOnly refuses even when no Turn is active anywhere', async () => {
    const activation = { execute: vi.fn(async () => { throw new Error('must not activate'); }) };
    const receipts = createReceipts();
    const service = createSteerSessionService({
      turns: {
        activeTurnId: () => undefined,
        steerActiveTurn: vi.fn(async () => ({ status: 'not-running' })),
      },
      activation,
      receipts,
    });

    const result = await service.steer(steerInput({ receiptLookupOnly: true }));

    expect(result).toEqual({ delivered: false, reason: 'active-turn' });
    expect(activation.execute).not.toHaveBeenCalled();
  });

  it('scopes receipts per Session: another session with the same key gets no duplicate', async () => {
    const { service, steerActiveTurn } = harness({
      // Only the OWNING session has the Turn active; the foreign one does not.
      activeTurnId: (sessionId) => (sessionId === 'session-1' ? 'turn-1' : undefined),
      deliveredTurnId: 'turn-1',
    });
    await service.steer(steerInput({ expectActiveTurnId: 'turn-1' }));

    const replay = await service.steer({
      ...steerInput({ expectActiveTurnId: 'turn-1' }),
      sessionId: 'session-other',
    });

    // The durable receipt is keyed by (sessionId, clientRequestId); a foreign
    // session under the same visible id has no receipt to answer with, so the
    // pinned miss stays an honest refusal.
    expect(replay).toEqual({ delivered: false, reason: 'active-turn' });
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
  });
});

function receipt(turnId: string): TurnIngressReceipt {
  return {
    sessionId: 'session-1',
    turnId,
    inputDigest: 'sha256:test',
    acceptedSequence: 1,
  };
}

/** In-memory receipts implementing the TurnRepository receipt contract. */
function createReceipts() {
  const receipts = new Map<string, TurnIngressReceipt>();
  const byKey = (sessionId: string, clientRequestId: string) =>
    `${sessionId}\u0000${clientRequestId}`;
  return {
    receipts,
    /** Pre-seed one delivered receipt (the persisted replay state). */
    seed(sessionId: string, clientRequestId: string, turnId: string): void {
      receipts.set(byKey(sessionId, clientRequestId), {
        ...receipt(turnId),
        sessionId,
      });
    },
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
        receipts.set(key, { ...receipt(input.turnId), sessionId: input.sessionId });
        return { status: 'reserved' as const };
      },
    ),
    releaseSteeringReceipt: vi.fn(
      async (input: {
        readonly sessionId: string;
        readonly clientRequestId: string;
        readonly turnId: string;
      }) => {
        const key = byKey(input.sessionId, input.clientRequestId);
        if (receipts.get(key)?.turnId === input.turnId) receipts.delete(key);
      },
    ),
  };
}

/** Service over in-memory receipts; the owning test delivers the first steer itself. */
function harness(options: {
  activeTurnId: string | ((sessionId: string) => string | undefined);
  deliveredTurnId: string;
}) {
  const receipts = createReceipts();
  const steerActiveTurn = vi.fn(async () => ({
    status: 'accepted' as const,
    turnId: options.deliveredTurnId,
  }));
  const service = createSteerSessionService({
    turns: {
      activeTurnId: (sessionId: string) =>
        typeof options.activeTurnId === 'function'
          ? options.activeTurnId(sessionId)
          : options.activeTurnId,
      steerActiveTurn,
    },
    activation: { execute: vi.fn(async () => { throw new Error('must not activate'); }) },
    receipts,
  });
  return { receipts, service, steerActiveTurn };
}

function steerInput(
  extra: Partial<
    Pick<SteerSessionInput, 'expectActiveTurnId' | 'receiptLookupOnly' | 'sessionId'>
  >,
): SteerSessionInput {
  return {
    sessionId: 'session-1',
    input: { text: 'change course' },
    provenance: { source: 'api', routingFingerprint: 'steer-session-test' },
    producerId: 'mcode-acp',
    idempotencyKey: 'req-1',
    ...extra,
  };
}
