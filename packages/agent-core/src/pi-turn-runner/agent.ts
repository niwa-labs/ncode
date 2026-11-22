import { Agent, type FinishTurn, type runAgentLoop } from '@earendil-works/pi-agent-core';
import { withNcodeUserAgent } from '@mavis/shared/product-build-identity';
import { formatUserAgent, getCurrentSystemMessage, type UserMessage } from '@earendil-works/pi-ai';
import { diffSystemPromptSections } from '@earendil-works/pi-coding-agent';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import { ContextWireImageBudgetExceeded, contextWireRequestMessages } from './context-wire.js';
import { projectAgentMessagesForModel } from './outbound-message-normalizer.js';
import { resolveMaxImagesPerRequest } from './request-image-limit.js';
import { createRequestSnapshotBoundary, type RequestSnapshotBoundary } from './request-snapshot.js';
import { failureReason } from './terminal.js';
import type { turnState } from './turn.js';
import type { UserMessageInput } from './types.js';

type PiUserMessage = UserMessage &
  Pick<UserMessageInput, 'canonicalTextRange' | 'genuineUserQueryText' | 'hostMetadata'>;

export function toPiUserMessage(input: UserMessageInput): PiUserMessage {
  const message: PiUserMessage = {
    role: 'user',
    content: [{ type: 'text', text: input.text }, ...(input.attachments ?? [])],
    timestamp: input.timestamp ?? Date.now(),
    ...(input.canonicalTextRange
      ? {
          canonicalTextRange: {
            startOffset: input.canonicalTextRange.startOffset,
            endOffset: input.canonicalTextRange.endOffset,
          },
        }
      : {}),
    ...(input.genuineUserQueryText !== undefined
      ? { genuineUserQueryText: input.genuineUserQueryText }
      : {}),
    ...(input.hostMetadata ? { hostMetadata: { ...input.hostMetadata } } : {}),
  };
  return message;
}

export function newAgent(turn: turnState, runLoop?: typeof runAgentLoop): Agent {
  // W04 C-obligation: canonical snapshot at EVERY prepareRequest boundary —
  // first request included — whenever the host wired the W02/W03 bridge.
  // Absent supplier (legacy default) leaves the pin hook unset, so behavior
  // is byte-identical to the pre-bridge path.
  const requestSnapshots: RequestSnapshotBoundary = createRequestSnapshotBoundary({
    sessionId: turn.input.sessionId,
    turnId: turn.input.turnId,
    logger: turn.logger,
    ...(turn.input.prepareRequestSnapshot
      ? { supplier: turn.input.prepareRequestSnapshot }
      : {}),
  });
  turn.requestSnapshots = requestSnapshots;
  return new Agent({
    ...(runLoop ? { runLoop } : {}),
    // Product transports own attribution; do not adopt Pi CLI branding.
    identity: { attribution: null, userAgent: { custom: withNcodeUserAgent(formatUserAgent()) } },
    initialState: {
      ...(turn.input.systemPromptSections ? {} : { systemPrompt: turn.input.systemPrompt }),
      model: turn.llm.model,
      thinkingLevel: turn.thinkingLevel,
      tools: turn.tools,
      messages: turn.input.systemPromptSections ? turn.initialMessages :
        turn.initialMessages.filter((message) => message.role !== 'system' || message.sections === undefined),
    },
    convertToLlm: (messages) => {
      // Ш4 context-wire: the composition-owned memoized pipeline compiles the
      // provider-bound payload. A structured-image budget rejection stops the
      // request. Other projection failures fall back to legacy conversion. Note the
      // request-shaping contract: the projected window replaces the payload
      // derived from `messages`; request-only before-LLM message replacements
      // (context lifecycle) are superseded by the pipeline's own window.
      // The transcript's system messages are NOT part of the window — they
      // carry the system prompt and the tool declarations the provider
      // request is shaped from — so they ride verbatim ahead of the
      // projection (see `contextWireRequestMessages`).
      if (turn.input.contextWire) {
        try {
          const request = turn.input.contextWire.project();
          if (request) {
            turn.logger.info(
              {
                session_id: turn.input.sessionId,
                turn_id: turn.input.turnId,
                provider: turn.llm.model.provider,
                record_count: request.records.length,
                total_bytes: request.totalBytes,
                last_roles: request.records.slice(-6).map((record) => record.role),
                last_tool_results: request.records.slice(-6).flatMap((record) =>
                  record.toolCallId ? [record.toolCallId] : [],
                ),
              },
              '[pi-turn-runner] context-wire payload projected',
            );
            return contextWireRequestMessages(messages, request, turn.llm.model);
          }
          turn.logger.debug(
            {
              session_id: turn.input.sessionId,
              turn_id: turn.input.turnId,
              provider: turn.llm.model.provider,
            },
            '[pi-turn-runner] context-wire projection unavailable; legacy conversion used',
          );
        } catch (error) {
          if (error instanceof ContextWireImageBudgetExceeded) throw error;
          turn.logger.warn(
            {
              session_id: turn.input.sessionId,
              turn_id: turn.input.turnId,
              provider: turn.llm.model.provider,
              error: error instanceof Error ? error.message : String(error),
            },
            '[pi-turn-runner] context-wire projection failed; legacy conversion used for this request',
          );
        }
      }
      const outbound = projectAgentMessagesForModel(messages, turn.llm.model);
      if (outbound.removedCount > 0) {
        turn.logger.warn(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            removed_count: outbound.removedCount,
          },
          '[pi-turn-runner] removed orphan tool results from provider-bound history',
        );
      }
      const undeterminedImages = Object.entries(outbound.undeterminedImageMimeTypes);
      if (undeterminedImages.length > 0) {
        // Images kept because their size is unreadable. A recurring cluster here
        // is the signal to teach imageDimensions another format. Diagnostic, not
        // an error: nothing is broken, the block is deliberately passed through,
        // and history is re-projected on every request of the session.
        turn.logger.info(
          {
            event: 'outbound_image_size_undetermined',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            undetermined_image_count: undeterminedImages.reduce(
              (total, [, count]) => total + count,
              0,
            ),
            undetermined_image_mime_types: outbound.undeterminedImageMimeTypes,
          },
          '[pi-turn-runner] kept provider-bound images whose dimensions could not be determined',
        );
      }
      if (outbound.omittedImageCount > 0) {
        // History keeps every image; only this request copy drops the oldest
        // ones so it stays within the model's per-request image limit (#425).
        turn.logger.info(
          {
            event: 'outbound_images_limited',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            omitted_image_count: outbound.omittedImageCount,
            max_images_per_request: resolveMaxImagesPerRequest(turn.llm.model),
          },
          '[pi-turn-runner] replaced older provider-bound images with placeholders',
        );
      }
      return outbound.messages;
    },
    streamFn: turn.streamFn,
    getApiKey: (provider) => (provider === turn.llm.model.provider ? turn.llm.apiKey : undefined),
    toolExecution: 'parallel',
    sessionId: turn.input.sessionId,
    // W04 §5.1 row 32: shouldStopAfterTurn migrates onto the pin-native
    // finishTurn hook — product `true` → {action:"end"}, `false`/`undefined` →
    // undefined (normal scheduling). NEVER {action:"continue"}: an explicit
    // continuation would add a provider request the old hook never added.
    ...(turn.input.shouldStopAfterTurn
      ? {
          finishTurn: (async (completedTurn: Parameters<FinishTurn>[0], signal?: AbortSignal) =>
            (await turn.input.shouldStopAfterTurn?.(completedTurn)) === true
              ? ({ action: 'end' } as const)
              : undefined) satisfies FinishTurn,
        }
      : {}),
    // W04 §5.1 row 15: post-dequeue steering admission veto (pin seam, vendored).
    ...(turn.input.shouldStopAfterSteering
      ? { shouldStopAfterSteering: turn.input.shouldStopAfterSteering }
      : {}),
    // Reactive subagents §1.7 (wave 3): accepted-owner-input generation probe
    // for the pin's sequential-executor yield seam. Absent hosts keep the
    // batch behavior byte-identical.
    ...(turn.input.ownerInputGeneration
      ? { ownerInputGeneration: turn.input.ownerInputGeneration }
      : {}),
    // W04 §5.1 row 1: opt-in finalization of unexpected provider tool calls.
    ...(turn.input.unexpectedToolCallFallback
      ? { unexpectedToolCallFallback: turn.input.unexpectedToolCallFallback }
      : {}),
    ...(requestSnapshots.prepareRequest ? { prepareRequest: requestSnapshots.prepareRequest } : {}),
    ...(turn.llm.payloadTransform ? { onPayload: turn.llm.payloadTransform } : {}),
    ...(turn.llm.responseObserver ? { onResponse: turn.llm.responseObserver } : {}),
  });
}

export async function runAgent(
  agent: Agent,
  turn: turnState,
  convergeAtIdle?: () => Promise<void>,
): Promise<TurnTerminationReason | undefined> {
  const startMode = turn.input.startMode ?? 'prompt';
  try {
    if (turn.input.systemPromptSections) {
      const patch = diffSystemPromptSections(
        getCurrentSystemMessage(agent.state.messages)?.sections ?? {},
        { ...turn.input.systemPromptSections },
      );
      if (patch) {
        agent.state.messages = [...agent.state.messages, {
          role: 'system', content: '', sections: patch, timestamp: Date.now(),
        }];
        // Persist before the request, including continuation without a new user.
        await turn.history?.flushTail();
      }
    }
    if (startMode === 'continue') {
      await agent.continue();
    } else {
      await agent.prompt([
        ...(turn.input.beforeUserMessages ?? []),
        toPiUserMessage(turn.input.userMessage),
      ]);
    }
    await runContextOverflowRecovery(agent, turn);
    await agent.waitForIdle();
    await convergeAtIdle?.();
    await agent.waitForIdle();
    if (turn.input.signal?.aborted) {
      return { kind: 'aborted' };
    }
    if (agent.state.errorMessage) {
      return failureReason(
        agent.state.errorMessage,
        turn.metrics.getLLMFailureObservation()?.normalized,
      );
    }
    return undefined;
  } catch (err) {
    if (turn.input.signal?.aborted) {
      return { kind: 'aborted' };
    }
    const runError = err instanceof Error ? err.message : String(err);
    turn.logger.error(
      {
        session_id: turn.input.sessionId,
        turn_id: turn.input.turnId,
        start_mode: startMode,
        error: runError,
      },
      '[pi-turn-runner] agent start threw',
    );
    return failureReason(runError);
  }
}

/**
 * В1 (opus-decisions-20261101) context-overflow recovery at the loop level —
 * the pi `_checkCompaction`/`agent.continue()` shape (agent-session.ts
 * :3037-3107). The transport retry inside `withLLMRetry` re-sends the SAME
 * provider context, so an overflowed request can only be retried where the
 * context is rebuilt: after the run settles with an overflow-failed
 * response, the failed response is rejected out of the transcript (the same
 * surgery the response-control discard path applies) and the host recovery
 * wraps the ONE continuation whose request recompiles the context — the
 * compacted window in wire mode. Absent recovery or a non-overflow failure
 * changes nothing.
 */
async function runContextOverflowRecovery(agent: Agent, turn: turnState): Promise<void> {
  const recovery = turn.input.llmRetry?.contextOverflowRecovery;
  const failure = agent.state.errorMessage;
  if (recovery === undefined || failure === undefined || turn.input.signal?.aborted) return;
  if (!recovery.isOverflowError(failure)) return;
  turn.logger.info(
    {
      session_id: turn.input.sessionId,
      turn_id: turn.input.turnId,
      error: failure,
    },
    '[pi-turn-runner] context overflow failed the request; compacting once and retrying',
  );
  rejectFailedAssistantResponse(agent, turn);
  await recovery.recover(() => agent.continue(), { error: failure });
}

/**
 * Removes the failed assistant response (the transcript tail) from the agent
 * state and marks it rejected so `transformContext` also strips any
 * loop-context copy before the recovery's continuation request — the exact
 * steps of the response-control `discardAssistantMessage` path (events.ts),
 * minus the in-flight bridge reset that no longer applies after the run
 * settled. Without this, `agent.continue()` refuses ("Cannot continue from
 * message role: assistant") and the retried request would re-send the failed
 * response.
 *
 * The failed response's `message_end` already delivered it through
 * `onHistoryChangedHook` (the run settled before the recovery starts), so the
 * removal also rewinds the history delivery cursor: without the explicit
 * reconciliation the recovery answer — appended at the same index the failed
 * response vacated — is swallowed by the length-based `flushTail` and never
 * reaches durable history.
 */
function rejectFailedAssistantResponse(agent: Agent, turn: turnState): void {
  const messages = agent.state.messages;
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'assistant') return;
  turn.rejectedAssistantMessages.add(last);
  agent.state.messages = messages.slice(0, -1);
  turn.history?.reconcileRemoval();
}
