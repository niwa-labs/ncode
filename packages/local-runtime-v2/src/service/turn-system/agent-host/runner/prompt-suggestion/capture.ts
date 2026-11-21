import { createLogger } from '@mavis/logging';
import type { LLMModelConfig, PiTurnHooks, RunTurnCaller } from '@mavis/agent-core/pi-turn-runner';

const log = createLogger('mcode:prompt-suggestion');
import type { AgentHostTurnOutcome } from '../../contracts.js';
import type { LocalTurnExecutionInput } from '../contracts.js';
import { buildPromptSuggestionPayloadTransform } from '../../assembly/local-turn-payload-transform.js';
import {
  createPromptSuggestionCapture,
  type PromptSuggestionCapture,
  type PromptSuggestionTurnPort,
} from './prompt-suggestion-service.js';

/**
 * Installs the capture Hooks only when the port is present and enabled, so a
 * disabled feature adds no Hook and keeps the main request untouched.
 *
 * OUR surface gate (the upstream equivalent is `promptSuggestionSurface`,
 * which cannot work on a shared daemon runtime): the TURN must carry the
 * interactive marker its TUI sender attached (`provenance.sourceContext
 * .surface === 'interactive'`). An ACP/exec/queue turn never carries it, so
 * headless clients pay ZERO extra model requests and receive zero events —
 * the feature is invisible to them even when enabled for the daemon.
 */
export function createTurnPromptSuggestionCapture(
  input: LocalTurnExecutionInput,
  prepared: { readonly llm: LLMModelConfig; readonly caller: RunTurnCaller },
  options: Parameters<typeof buildPromptSuggestionPayloadTransform>[1] & {
    readonly promptSuggestion?: PromptSuggestionTurnPort;
  },
): { readonly capture: ReturnType<typeof createPromptSuggestionCapture> } | undefined {
  const port = options.promptSuggestion;
  const gate = (() => {
    if (!port) return 'no_port';
    if (!port.enabled()) return 'disabled';
    if (prepared.caller !== 'chat') return 'caller';
    if (input.session.parentSessionId) return 'child_session';
    if ((input.session.interactionMode ?? 'default') !== 'default') return 'interaction_mode';
    if (input.request.provenance.sourceContext?.surface !== 'interactive') return 'surface';
    if (isAutomaticOrPlannedTurn(input)) return 'automatic_or_planned';
    return undefined;
  })();
  if (gate) {
    // Diagnose only when the feature is on: a disabled/headless refusal is
    // the designed quiet path and must not log anything.
    if (port && port.enabled() && gate !== 'disabled') {
      log.warn('prompt suggestion capture refused', {
        session_id: input.lease.sessionId,
        turn_id: input.lease.turnId,
        gate,
      });
    }
    return undefined;
  }
  return {
    capture: createPromptSuggestionCapture(
      prepared.llm,
      (signal) =>
        buildPromptSuggestionPayloadTransform(
          {
            agentConfig: input.preparation.agentConfig,
            llm: { ...input.preparation.llm, ...prepared.llm },
            sessionId: input.lease.sessionId,
            signal,
          },
          options,
        ),
      // The suggestion uses this turn's model, so it reviews exactly as the reply does:
      // a BYOK model is not sent to content review.
      input.preparation.llm.managedProvider === true,
    ),
  };
}

/** Narrows one accepted Turn to the composer-facing cases only. */
export function readPromptSuggestionScope(
  input: LocalTurnExecutionInput,
  prepared: { readonly llm: LLMModelConfig; readonly caller: RunTurnCaller },
  capture: ReturnType<typeof createPromptSuggestionCapture> | undefined,
  replyMessageId?: string,
): PromptSuggestionScope | undefined {
  if (
    !capture ||
    prepared.caller !== 'chat' ||
    input.session.parentSessionId ||
    (input.session.interactionMode ?? 'default') !== 'default'
  )
    return undefined;
  return {
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    caller: prepared.caller,
    session: {
      parentSessionId: input.session.parentSessionId ?? undefined,
      interactionMode: input.session.interactionMode,
    },
    capture: capture.read(),
    ...(replyMessageId ? { messageId: replyMessageId } : {}),
  };
}

export interface PromptSuggestionScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly caller: string;
  readonly session: {
    readonly parentSessionId?: string;
    readonly interactionMode?: string;
  };
  readonly capture: PromptSuggestionCapture | undefined;
  /** The reply this suggestion follows; see `replyMessageId`. */
  readonly messageId?: string;
}

type PromptSuggestionHookCapture = ReturnType<typeof createPromptSuggestionCapture>;

/** Appends the capture Hooks without replacing any existing Hook. */
export function withPromptSuggestionHooks(
  hooks: PiTurnHooks,
  capture: PromptSuggestionHookCapture | undefined,
): PiTurnHooks {
  if (!capture) return hooks;
  return {
    ...hooks,
    onLlmCallPreparedHook: [...(hooks.onLlmCallPreparedHook ?? []), capture.preparedHook],
    afterLlmCallHook: [...(hooks.afterLlmCallHook ?? []), capture.assistantHook],
  };
}

function isAutomaticOrPlannedTurn(input: LocalTurnExecutionInput): boolean {
  return Boolean(
    input.assemblyContext.plan?.active ||
    input.assemblyContext.turnIntent?.kind.startsWith('goal-') ||
    input.request.provenance.source === 'thread-goal' ||
    !isUserDrivenTurn(input),
  );
}

/**
 * The user is at the composer for this Turn: they typed its query, or it
 * resumes on their questionnaire answer (which carries no user-authored query
 * text, yet the answer it produces is read right there).
 */
function isUserDrivenTurn(input: LocalTurnExecutionInput): boolean {
  return (
    input.request.genuineUserQueryText.trim().length > 0 ||
    input.request.provenance.source === 'questionnaire'
  );
}

/**
 * Holds a Turn's suggestion scope between its settlement and the Host's
 * terminal commit, keyed by the returned outcome object so it never reaches
 * the public contract and is collected with that outcome.
 */
export class PromptSuggestionCommitRelay {
  private readonly scopes = new WeakMap<AgentHostTurnOutcome, PromptSuggestionScope>();

  constructor(private readonly port: () => PromptSuggestionTurnPort | undefined) {}

  /** Only a completed, non-waiting Turn with a capture can offer a suggestion. */
  remember(outcome: AgentHostTurnOutcome, scope: PromptSuggestionScope | undefined): void {
    if (!scope?.capture || outcome.status !== 'completed' || outcome.waitingForUser) return;
    this.scopes.set(outcome, scope);
  }

  /** Best-effort and never awaited: a suggestion can never fail a committed Turn. */
  committed(outcome: AgentHostTurnOutcome): void {
    const scope = this.scopes.get(outcome);
    if (!scope) return;
    this.scopes.delete(outcome);
    const port = this.port();
    if (!port || !scope.capture) return;
    try {
      port.committed(
        {
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          caller: scope.caller,
          session: scope.session,
          ...(scope.messageId ? { messageId: scope.messageId } : {}),
        },
        scope.capture,
      );
    } catch {
      /* An optional suggestion can never fail a committed Turn. */
    }
  }
}
