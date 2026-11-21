import type {
  ActivateTurnResult,
  SteerSessionInput,
  SteerSessionResult,
  TurnActivationSubmission,
  TurnMessageSubmission,
} from '../../contracts.js';
import { isUserSteeringProducer } from '../../agent-host/contracts.js';
import type { AgentHostSteeringMessage } from '../../agent-host/contracts.js';
import { captureAgentHostSteeringInput } from '../../agent-host/canonical-user-input.js';
import type { TurnExecutionService } from '../contracts.js';
import type { TurnRepository } from '../../persistence/contracts.js';
import { resolveGenuineUserQueryText } from '../message-query-authorship.js';
import { steeringMessageKey, steeringReceiptId } from '../../steering-identity.js';
import { createUserMessageId } from '../../../session-system/shared/user-message-id.js';
import { createLogger } from '@mavis/logging';

/** §5.5: the owner-input release reactivity timeline sink. */
const reactiveTimelineLog = createLogger('mcode:reactive');

interface TurnActivation {
  execute(input: TurnActivationSubmission): Promise<ActivateTurnResult>;
}

/**
 * The wave-3 delegation-steering ingress (steering-design-sol.md §2.2–§2.3),
 * structurally satisfied by `DelegationSteeringComposition`. Optional on the
 * steer path: without it the service keeps exactly today's behaviour; with
 * it, a steer delivered to an ACTIVE Turn is first committed through the
 * durable seam (the saved-ack, §6.1) and its committed-steer release
 * (§2.3) is performed BEFORE the Turn continues — so the runtime's next
 * provider request starts against the already-released state (§6.2 gate).
 */
export interface SteerDelegationSteering {
  acceptOwnerInput(input: {
    readonly conversationId: string;
    readonly requestId: string;
    readonly content: unknown;
    readonly whenBusy: 'steer' | 'followUp';
  }): Promise<{
    readonly status: string;
    readonly inputEntryId: string;
    readonly commitSeq: number;
    readonly submissionId: string;
  }>;
  onCommittedSteer(steer: {
    readonly parentConversationId: string;
    readonly requestId?: string;
    readonly parentRunId?: string;
  }): Promise<unknown>;
  /**
   * Native task-wait replay support (verdict 09 §1.6): records that a trusted
   * owner input was accepted for `(conversationId, turnId)` and its release
   * pass is being committed. A task wait that registers for the same round
   * AFTER this fact is released by the replay instead of re-parking the
   * parent behind an already-accepted input. Optional: absent when the
   * composition has no native binding.
   */
  noteOwnerReleaseIntent?(conversationId: string, turnId: string): void | Promise<void>;
}

interface SteerSessionServiceOptions {
  readonly turns: Pick<TurnExecutionService, 'activeTurnId' | 'steerActiveTurn'>;
  readonly activation: TurnActivation;
  readonly receipts: Pick<
    TurnRepository,
    'findSteeringReceipt' | 'reserveSteeringReceipt' | 'releaseSteeringReceipt'
  >;
  readonly delegationSteering?: SteerDelegationSteering;
}

type ActiveDeliveryReservation =
  | { readonly kind: 'deliver'; readonly receiptReserved: boolean }
  | { readonly kind: 'duplicate'; readonly turnId: string }
  | { readonly kind: 'not-accepted' };

interface ReservedActiveDelivery {
  readonly input: SteerSessionInput;
  readonly clientRequestId: string | undefined;
  readonly activeTurnId: string;
  readonly reservation: Extract<ActiveDeliveryReservation, { readonly kind: 'deliver' }>;
}

type ActivationSteerOutcome =
  | { readonly kind: 'result'; readonly result: SteerSessionResult }
  | { readonly kind: 'race'; readonly reason: ActiveRaceReason };

type ActiveRaceReason = 'active-turn' | 'compaction-active';

export function createSteerSessionService(options: SteerSessionServiceOptions): {
  steer(input: SteerSessionInput): Promise<SteerSessionResult>;
} {
  return {
    steer: (input) =>
      deliver(
        options,
        identifyVisibleSteering({
          ...input,
          ...(isUserSteeringProducer(input.producerId)
            ? { createdAt: input.createdAt ?? Date.now() }
            : {}),
        }),
      ),
  };
}

async function deliver(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
): Promise<SteerSessionResult> {
  const clientRequestId = durableSteeringReceiptId(input);
  if (clientRequestId) {
    const receipt = await options.receipts.findSteeringReceipt({
      sessionId: input.sessionId,
      clientRequestId,
    });
    if (receipt) {
      // §1.2: a repeat of the same accepted replica is idempotent — it never
      // re-delivers content, but it DOES re-run the owner release pass so a
      // release that failed after the first delivery is retried (the seam
      // accept replays, the release is keyed by the wait). Read-only probes
      // and machine deliveries never release.
      if (!input.receiptLookupOnly && isOwnerSteeringDelivery(input)) {
        try {
          await acceptDelegationSteering(options, {
            input,
            clientRequestId,
            activeTurnId: receipt.turnId,
            reservation: { kind: 'deliver', receiptReserved: false },
          });
          await options.delegationSteering?.noteOwnerReleaseIntent?.(input.sessionId, receipt.turnId);
          await options.delegationSteering?.onCommittedSteer({
            parentConversationId: input.sessionId,
            ...(clientRequestId !== undefined ? { requestId: clientRequestId } : {}),
          });
        } catch {
          // The duplicate answer is still authoritative; a failed retry leaves
          // the wait foreground and visible for the next owner input.
        }
      }
      return { delivered: true, mode: 'duplicate', turnId: receipt.turnId };
    }
  }
  if (input.receiptLookupOnly) {
    // A read-only repeat probe never admits content: without a durable
    // receipt there is nothing to answer the replay with, so it refuses like
    // a pinned miss. It must not reach the active-Turn delivery below (an
    // unrelated Turn may well be running) and must never activate one.
    return { delivered: false, reason: 'active-turn' };
  }
  const activeDelivery =
    input.clientIntent === 'cloud-handoff'
      ? undefined
      : await deliverToActive(options, input, clientRequestId);
  if (activeDelivery) return activeDelivery;
  if (input.expectActiveTurnId !== undefined) {
    // A caller that pinned the Turn it wants to join never activates a fresh
    // one: the pin is the wire-safe form of preDelivery's Turn check, so a
    // miss is a definitive refusal, not a race to re-run as a new Turn.
    return { delivered: false, reason: 'active-turn' };
  }
  return activateOrSteerRace(options, input, clientRequestId);
}

async function deliverToActive(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
  observedTurnId?: string,
): Promise<SteerSessionResult | undefined> {
  const turns = options.turns;
  const activeTurnId = observedTurnId ?? turns.activeTurnId(input.sessionId);
  if (!activeTurnId) return undefined;
  if (input.expectActiveTurnId !== undefined && input.expectActiveTurnId !== activeTurnId) {
    return { delivered: false, reason: 'active-turn' };
  }
  if (hasModelOverride(input.input.model) && input.modelSelectionScope !== 'activation-only') {
    return { delivered: false, reason: 'active-model-override-unsupported' };
  }
  return deliverToKnownActive(options, activeSteeringInput(input), clientRequestId, activeTurnId);
}

async function deliverToKnownActive(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
  activeTurnId: string,
): Promise<SteerSessionResult | undefined> {
  const reservation = await reserveActiveDeliveryReceipt(
    options,
    input.sessionId,
    clientRequestId,
    activeTurnId,
  );
  if (reservation.kind === 'duplicate') {
    return { delivered: true, mode: 'duplicate', turnId: reservation.turnId };
  }
  if (reservation.kind === 'not-accepted') return undefined;
  return deliverToReservedActive(options, {
    input,
    clientRequestId,
    activeTurnId,
    reservation,
  });
}

async function reserveActiveDeliveryReceipt(
  options: SteerSessionServiceOptions,
  sessionId: string,
  clientRequestId: string | undefined,
  turnId: string,
): Promise<ActiveDeliveryReservation> {
  if (!clientRequestId) return { kind: 'deliver', receiptReserved: false };
  const receipt = await options.receipts.reserveSteeringReceipt({
    sessionId,
    clientRequestId,
    turnId,
  });
  if (receipt.status === 'duplicate') return { kind: 'duplicate', turnId: receipt.turnId };
  if (receipt.status === 'not-accepted') return { kind: 'not-accepted' };
  return { kind: 'deliver', receiptReserved: true };
}

async function deliverToReservedActive(
  options: SteerSessionServiceOptions,
  delivery: ReservedActiveDelivery,
): Promise<SteerSessionResult | undefined> {
  const { activeTurnId, input } = delivery;
  // §5.5: the reactivity timeline of the owner-input release. The boundaries
  // are the existing observable facts (owner input accepted / release
  // committed); the next provider request start follows in the same executor
  // that parked the tool and is logged at `turn start` on the mcode:turn sink.
  const releaseTimelineOwner = isOwnerSteeringDelivery(input);
  const acceptedAtMs = Date.now();
  try {
    // §2.2: the durable committed accept (saved-ack) FIRST — it is the fact
    // the input was accepted, independent of any release outcome. §6.1: a
    // storage failure here is a VISIBLE steer failure (the receipt is
    // compensated, nothing is delivered) — never a silent drop.
    await acceptDelegationSteering(options, delivery);
    await input.preDelivery?.accept({ mode: 'steered', turnId: activeTurnId });
  } catch (error) {
    await releaseReservedReceipt(options, delivery);
    throw error;
  }
  if (releaseTimelineOwner) {
    logReactiveTimeline(input.sessionId, activeTurnId, 'reactive_owner_input_accepted', {
      producerId: input.producerId,
    });
  }
  const result = await steer(options.turns, input, activeTurnId);
  if (!result.delivered) {
    // Controller returned a definitive non-acceptance, so no content reached
    // the active Turn and this receipt is safe to compensate.
    await releaseReservedReceipt(options, delivery);
    return result.delivered || result.reason === 'delivery-closed' ? result : undefined;
  }
  // §1.6 input-before-provider barrier: the owner input is enqueued FIRST
  // (guaranteed available to the next steering drain), THEN the release
  // commits. The parked task tool cannot return before the release, so the
  // next provider request necessarily carries both the user message and the
  // background note — never a released parent continuing the OLD instruction.
  // A failed release keeps the delivered input and the reserved receipt (the
  // replay answers duplicate AND re-runs this idempotent pass — §1.2), with
  // the control-plane failure surfaced to the caller.
  await releaseDelegationSteering(options, delivery, activeTurnId);
  if (releaseTimelineOwner) {
    logReactiveTimeline(input.sessionId, activeTurnId, 'reactive_release_committed', {
      acceptedToReleaseMs: Date.now() - acceptedAtMs,
    });
  }
  return result;
}

/** §5.5 reactivity timeline: structured facts on mcode:reactive, never a turn outcome. */
function logReactiveTimeline(
  sessionId: string,
  turnId: string,
  event: 'reactive_owner_input_accepted' | 'reactive_release_committed',
  fields: Record<string, unknown>,
): void {
  try {
    reactiveTimelineLog.info(`Reactive release timeline: ${event}`, {
      sessionId,
      turnId,
      event,
      ...fields,
    });
  } catch {
    // Diagnostic sinks cannot change a committed release.
  }
}

async function releaseReservedReceipt(
  options: SteerSessionServiceOptions,
  delivery: ReservedActiveDelivery,
): Promise<void> {
  if (!delivery.reservation.receiptReserved || !delivery.clientRequestId) return;
  await releaseKnownUndeliveredReceipt(
    options,
    delivery.input.sessionId,
    delivery.clientRequestId,
    delivery.activeTurnId,
  );
}

/**
 * The durable committed accept (§2.2) of one steer delivered to an ACTIVE
 * Turn. A replayed accept is the SAME committed input returning (redelivery),
 * not a new one — idempotent per `(conversationId, requestId)`.
 */
async function acceptDelegationSteering(
  options: SteerSessionServiceOptions,
  delivery: ReservedActiveDelivery,
): Promise<void> {
  const delegation = options.delegationSteering;
  if (!delegation) return;
  const { input, clientRequestId } = delivery;
  const requestId = clientRequestId ?? input.idempotencyKey;
  // JSON-safe projection of the steer into the seam store (it stores and
  // hashes JsonValue): the committed text of the input, per §2.2.
  const accepted = await delegation.acceptOwnerInput({
    conversationId: input.sessionId,
    requestId,
    content: { text: input.input.text },
    whenBusy: 'steer',
  });
  if (accepted.status !== 'committed' && accepted.status !== 'replayed') {
    throw new Error(`delegation steering accept rejected the steer (${accepted.status})`);
  }
}

/**
 * The committed-steer release reaction (§2.3) — OWNER-ONLY (verdict 09 §1.2).
 * Machine deliveries through this ingress (background-task completion,
 * reminders, cron) are NOT a new owner replica and must never release a
 * foreground task wait; the followUp exception never reaches this path.
 */
async function releaseDelegationSteering(
  options: SteerSessionServiceOptions,
  delivery: ReservedActiveDelivery,
  activeTurnId: string,
): Promise<void> {
  const delegation = options.delegationSteering;
  if (!delegation) return;
  const { input, clientRequestId } = delivery;
  if (!isOwnerSteeringDelivery(input)) return;
  const requestId = clientRequestId ?? input.idempotencyKey;
  // The intent is recorded BEFORE the pass so a task wait that registers for
  // this round while the pass runs is replay-released instead of re-parking.
  // Wave 3: the note is also the DURABLE fact (the seam's deterministic
  // release-intent entry), so the await puts the durable fact ahead of the
  // committed release decision.
  await delegation.noteOwnerReleaseIntent?.(input.sessionId, activeTurnId);
  await delegation.onCommittedSteer({
    parentConversationId: input.sessionId,
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

/**
 * Trusted owner-input classification (§1.2): the producer is either one of
 * the turn-system's user steering producers, or a producer whose source is a
 * user-facing surface. Machine deliveries are recognized by their TRUSTED
 * route, never by message text: the background-task completion
 * (`background-task` source, delivered by `background-task-delivery`), cron
 * wakes, thread-goal and greeting deliveries. Everything else reaching this
 * ingress is runtime (TUI/RPC/channel) user steering — the runtime assigns
 * `producerId`/`source` itself at the ingress boundary, so a producer string
 * from unverified external input never classifies the delivery here.
 */
export function isOwnerSteeringDelivery(input: SteerSessionInput): boolean {
  if (isUserSteeringProducer(input.producerId)) return true;
  const source = input.provenance.source;
  if (
    source === 'background-task' ||
    source === 'cron' ||
    source === 'thread-goal' ||
    source === 'greeting'
  ) {
    return false;
  }
  return true;
}

async function activateOrSteerRace(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
): Promise<SteerSessionResult> {
  const activated = await options.activation.execute(steerActivationInput(input, clientRequestId));
  const outcome = activationSteerOutcome(activated);
  if (outcome.kind === 'result') return outcome.result;
  if (input.clientIntent === 'cloud-handoff') return { delivered: false, reason: outcome.reason };
  return deliverToRacedActive(options, input, clientRequestId, outcome.reason);
}

function steerActivationInput(
  input: SteerSessionInput,
  clientRequestId: string | undefined,
): TurnActivationSubmission {
  return {
    sessionId: input.sessionId,
    input: input.input,
    clientRequestId: clientRequestId ?? input.idempotencyKey,
    provenance: input.provenance,
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    ...(input.resumePausedQueue
      ? { admissionPriority: { kind: 'paused-queue-send' as const } }
      : {}),
    ...(input.outputContract ? { outputContract: input.outputContract } : {}),
    ...(input.admissionPriority ? { admissionPriority: input.admissionPriority } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
    ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
    delivery: activationDelivery(input),
    immediateSendBatch: input.immediateSendBatch,
  };
}

function activationDelivery(input: SteerSessionInput): TurnMessageSubmission['delivery'] {
  const preDelivery = input.preDelivery;
  return {
    ...input.delivery,
    messageKey: steeringMessageKey(input),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
    ...(preDelivery
      ? {
          preDelivery: {
            accept: ({ turnId }) => preDelivery.accept({ mode: 'activated', turnId }),
          },
        }
      : {}),
  };
}

function activationSteerOutcome(activated: ActivateTurnResult): ActivationSteerOutcome {
  if (activated.accepted) {
    return { kind: 'result', result: activatedResult(activated) };
  }
  if (activated.reason === 'duplicate') {
    return {
      kind: 'result',
      result: { delivered: true, mode: 'duplicate', turnId: activated.turnId },
    };
  }
  // Wave-0 item 0.6: a compaction lease is NOT a joinable race — the
  // controller refuses steering for a compaction turn by contract
  // (`unsupported-delivery`), so racing the observed active turn would only
  // re-run the accept cycle against a turn that can never consume it. The
  // refusal surfaces honestly as `compaction-active` (the caller — the
  // runtime queue fallback included — accumulates the input instead).
  if (activated.reason === 'compaction-active') {
    return { kind: 'result', result: { delivered: false, reason: 'compaction-active' } };
  }
  if (isActiveRaceReason(activated.reason)) {
    return { kind: 'race', reason: activated.reason };
  }
  return { kind: 'result', result: { delivered: false, reason: activated.reason } };
}

function activatedResult(
  activated: Extract<ActivateTurnResult, { readonly accepted: true }>,
): SteerSessionResult {
  return {
    delivered: true,
    mode: 'activated',
    turnId: activated.turnId,
    completion: activated.completion,
  };
}

function isActiveRaceReason(reason: string): reason is ActiveRaceReason {
  return reason === 'active-turn' || reason === 'compaction-active';
}

async function deliverToRacedActive(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
  rejectionReason: ActiveRaceReason,
): Promise<SteerSessionResult> {
  const racedTurnId = options.turns.activeTurnId(input.sessionId);
  if (!racedTurnId) return { delivered: false, reason: rejectionReason };
  const raced = await deliverToActive(options, input, clientRequestId, racedTurnId);
  return raced ?? { delivered: false, reason: 'active-turn' };
}

function activeSteeringInput(input: SteerSessionInput): SteerSessionInput {
  if (input.modelSelectionScope !== 'activation-only' || !input.input.model) return input;
  const { model: activationPreference, ...activeInput } = input.input;
  // The join never switches the running Turn's model, but an exit-boundary
  // requeue turns this message into a fresh query that must keep the user's
  // explicit choice.
  return { ...input, input: activeInput, requeueModel: activationPreference };
}

async function releaseKnownUndeliveredReceipt(
  options: SteerSessionServiceOptions,
  sessionId: string,
  clientRequestId: string,
  turnId: string,
): Promise<void> {
  try {
    await options.receipts.releaseSteeringReceipt({ sessionId, clientRequestId, turnId });
  } catch {
    // The receipt stays durable on a compensation write failure. Replaying it
    // is less safe than accepting the documented at-most-once loss boundary.
  }
}

async function steer(
  turns: Pick<TurnExecutionService, 'steerActiveTurn'>,
  input: SteerSessionInput,
  turnId: string,
): Promise<SteerSessionResult> {
  const result = await turns.steerActiveTurn({
    sessionId: input.sessionId,
    turnId,
    ...(input.resumePausedQueue || isForegroundSteerSend(input.clientIntent)
      ? { foreground: true as const }
      : {}),
    message: bufferedSteeringMessage(input),
  });
  if (result.status === 'accepted') {
    return { delivered: true, mode: 'steered', turnId: result.turnId };
  }
  if (
    result.status === 'unsupported-delivery' ||
    result.status === 'delivery-closed' ||
    result.status === 'closing'
  ) {
    return { delivered: false, reason: 'delivery-closed' };
  }
  return { delivered: false, reason: 'active-turn' };
}

function bufferedSteeringMessage(input: SteerSessionInput): AgentHostSteeringMessage {
  const genuineUserQueryText = resolveGenuineUserQueryText({
    input: input.input,
    provenance: input.provenance,
    delivery: input.delivery,
  });
  const request = captureAgentHostSteeringInput({
    input: input.input,
    provenance: input.provenance,
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
  });
  const delivery = steeringDelivery(input.delivery);
  return {
    producerId: input.producerId,
    unstartedFromTurnIds: input.delivery?.unstartedFromTurnIds,
    ...(input.immediateSendBatch
      ? {
          batchMembers: input.immediateSendBatch.members.map((member, index) => ({
            producerId: input.producerId,
            idempotencyKey: `${input.idempotencyKey}:${member.userMessageId}`,
            messageKey: member.messageKey,
            userMessageId: member.userMessageId,
            createdAt: member.createdAt,
            unstartedFromTurnIds: [
              ...new Set([
                ...(member.unstartedFromTurnIds ?? []),
                ...(input.delivery?.unstartedFromTurnIds ?? []),
              ]),
            ],
            ...(member.unconsumedFromTurnIds
              ? { unconsumedFromTurnIds: member.unconsumedFromTurnIds }
              : {}),
            ...(member.sourceMessageId ? { sourceMessageId: member.sourceMessageId } : {}),
            ...(index === 0 && input.sourceMessageId
              ? { queueClaim: { itemId: input.sourceMessageId, claimId: input.idempotencyKey } }
              : {}),
            message: {
              text: member.message.content,
              attachments: member.message.attachments,
              ...(member.message.quotedMessage
                ? { quotedMessage: member.message.quotedMessage }
                : {}),
            },
            genuineUserQueryText: member.message.displayContent ?? member.message.content,
            provenance: member.provenance,
            delivery: {
              hideUserMessage: member.message.hideUserMessage,
              displayContent: member.message.displayContent,
              displayAttachments: member.message.displayAttachments,
            },
            ...(member.model
              ? {
                  requeueModel: {
                    providerId: member.model.provider_id,
                    modelId: member.model.model_id,
                    variant: member.model.variant,
                    thinking: member.model.thinking,
                  },
                }
              : {}),
          })),
        }
      : {}),
    ...(input.producerId === 'queue-immediate-send' && input.sourceMessageId
      ? { queueClaim: { itemId: input.sourceMessageId, claimId: input.idempotencyKey } }
      : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    idempotencyKey: input.idempotencyKey,
    ...(request.userMessageId ? { userMessageId: request.userMessageId } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.requeueModel ? { requeueModel: input.requeueModel } : {}),
    message: request.input,
    genuineUserQueryText,
    provenance: request.provenance,
    ...(delivery ? { delivery } : {}),
  };
}

function isPausedQueueSend(clientIntent: string | undefined): boolean {
  return clientIntent === 'paused-queue-keep' || clientIntent === 'paused-queue-clear';
}

/** Steer sends that keep an attached SSE consumer promote the Turn to foreground. */
function isForegroundSteerSend(clientIntent: string | undefined): boolean {
  return isPausedQueueSend(clientIntent) || clientIntent === 'composer-steer';
}

function durableSteeringReceiptId(input: SteerSessionInput): string | undefined {
  // The wire-safe Turn pin carries the same at-most-once contract as the
  // in-process callback: a producer that constrains admission keeps receipts.
  // The read-only probe rides the same receipts without ever reserving one.
  return input.preDelivery ||
    input.expectActiveTurnId !== undefined ||
    input.receiptLookupOnly
    ? steeringReceiptId(input)
    : undefined;
}

function identifyVisibleSteering(input: SteerSessionInput): SteerSessionInput {
  if (input.userMessageId || !projectsVisibleUserMessage(input.delivery)) return input;
  return {
    ...input,
    userMessageId: createUserMessageId({
      sessionId: input.sessionId,
      messageKey: steeringMessageKey(input),
    }),
  };
}

function projectsVisibleUserMessage(delivery: SteerSessionInput['delivery']): boolean {
  return (
    delivery?.hideUserMessage !== true ||
    (typeof delivery.displayContent === 'string' && delivery.displayContent.length > 0)
  );
}

function steeringDelivery(input: SteerSessionInput['delivery']) {
  if (!input) return undefined;
  const delivery = {
    ...(input.hideUserMessage !== undefined ? { hideUserMessage: input.hideUserMessage } : {}),
    ...(input.displayContent !== undefined ? { displayContent: input.displayContent } : {}),
    ...(input.displayAttachments
      ? { displayAttachments: input.displayAttachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
  return Object.keys(delivery).length > 0 ? delivery : undefined;
}

function hasModelOverride(model: SteerSessionInput['input']['model']): boolean {
  return Boolean(model?.providerId || model?.modelId || model?.variant);
}
