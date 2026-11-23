import { randomUUID } from 'node:crypto';

import * as acp from '@agentclientprotocol/sdk';

import { pendingQuestionnaireForTurn } from '../application/pending-questionnaire.js';
import type { TuiSession } from '../runtime/port.js';
import type { TuiAcpRuntime } from './runtime.js';
import { readTuiAcpSessionTools } from './tool-policy.js';

export const TUI_ACP_EXTENSION_VERSION = 1;

const TUI_ACP_GOAL_METHODS = [
  'mcode/session/goal/get',
  'mcode/session/goal/create',
  'mcode/session/goal/patch',
  'mcode/session/goal/clear',
] as const;

export const TUI_ACP_EXTENSION_METHODS = [
  'session/activate',
  'session/history',
  'mcode/session/activate',
  'mcode/session/steer',
  'mcode/session/queue/list',
  'mcode/session/queue/enqueue',
  'mcode/session/queue/update',
  'mcode/session/queue/delete',
  'mcode/session/queue/steer',
  'mcode/session/turn_status',
  'mcode/session/turn_result',
  'mcode/session/tools',
  ...TUI_ACP_GOAL_METHODS,
  'mcode/session/delegation/get',
  'mcode/session/delegation/stop',
] as const;

export const TUI_ACP_EXTENSION_NOTIFICATIONS = [
  'mcode/session/current_session_update',
  'mcode/session/queue_update',
  'mcode/session/goal_update',
  'mcode/session/delegation_update',
] as const;

export function tuiAcpExtensionCapabilities(runtime: Pick<TuiAcpRuntime, 'isGoalEnabled'>): {
  readonly methods: readonly string[];
  readonly notifications: readonly string[];
} {
  const goalEnabled = runtime.isGoalEnabled();
  return {
    methods: goalEnabled
      ? TUI_ACP_EXTENSION_METHODS
      : TUI_ACP_EXTENSION_METHODS.filter(
          (method) => !TUI_ACP_GOAL_METHODS.some((goalMethod) => goalMethod === method),
        ),
    notifications: goalEnabled
      ? TUI_ACP_EXTENSION_NOTIFICATIONS
      : TUI_ACP_EXTENSION_NOTIFICATIONS.filter(
          (notification) => notification !== 'mcode/session/goal_update',
        ),
  };
}

export interface RegisterTuiAcpExtensionsOptions {
  readonly app: acp.AgentApp;
  readonly runtime: TuiAcpRuntime;
  readonly resolveSession: (sessionId: string) => TuiSession | undefined;
  readonly activateSession: (sessionId: string) => void;
  readonly extensionNotificationsEnabled: () => boolean;
  readonly activePromptTurnId: (sessionId: string) => string | undefined;
  readonly createRequestId?: () => string;
}

export function registerTuiAcpExtensions(options: RegisterTuiAcpExtensionsOptions): void {
  const createRequestId = options.createRequestId ?? randomUUID;
  const resolve = (sessionId: string) => requireSession(options.resolveSession, sessionId);
  /**
   * Durable session resolution for the queue family. Queue operations are
   * session-id operations against the Runtime's durable queue — they must
   * not depend on THIS process's ACP attachment map: a follow_up
   * integration (or a client after reconnect) enqueues into a session that
   * was created by another process or resumed elsewhere. Resolve the
   * attachment first (cheap, already authorized by load), then fall back to
   * the Runtime's durable record; only a session unknown to the Runtime is
   * a Resource not found. Mirrors the attachment-free semantics of
   * `mcode/session/steer` in this same file.
   */
  const resolvePersisted = async (sessionId: string): Promise<TuiSession> => {
    const attached = options.resolveSession(sessionId);
    if (attached) return attached;
    try {
      return await options.runtime.getSession(sessionId);
    } catch {
      throw acp.RequestError.resourceNotFound(sessionId);
    }
  };
  const requireGoalEnabled = () => {
    if (!options.runtime.isGoalEnabled()) {
      throw acp.RequestError.invalidParams(
        undefined,
        'Goal extensions are disabled by the Runtime feature configuration.',
      );
    }
  };
  const activateSession = async (sessionId: string, client: acp.AgentContext) => {
    resolve(sessionId);
    options.activateSession(sessionId);
    if (options.extensionNotificationsEnabled()) {
      await client
        .notify('mcode/session/current_session_update', { sessionId })
        .catch(() => undefined);
    }
    return { sessionId };
  };

  options.app.onRequest('session/activate', parseSessionRequest, ({ params, client }) =>
    activateSession(params.sessionId, client),
  );
  options.app.onRequest('mcode/session/activate', parseSessionRequest, ({ params, client }) =>
    activateSession(params.sessionId, client),
  );

  options.app.onRequest('mcode/session/steer', parseTextRequest, async ({ params }) => {
    resolve(params.sessionId);
    const steerViaRuntime = async (
      input: Parameters<TuiAcpRuntime['steer']>[0],
    ): Promise<Awaited<ReturnType<TuiAcpRuntime['steer']>>> => {
      try {
        // The Turn constraint travels as DATA (expectActiveTurnId), not as the
        // preDelivery callback: in daemon mode this input crosses a JSON wire
        // where a function is silently dropped, and the daemon then dies on
        // `preDelivery.accept is not a function` — the steer never arrives.
        // The runtime enforces the pin where the active Turn actually lives.
        return await options.runtime.steer(input);
      } catch (error) {
        // Surface WHY the steer was not delivered instead of the connection
        // layer's bare "Internal error". Class identity is lost over the wire,
        // so the refusal is recognized by its stable error name.
        const cause = error instanceof Error ? error.message : String(error);
        const remoteName = (error as { readonly errorName?: unknown }).errorName;
        const errorName =
          typeof remoteName === 'string' ? remoteName : error instanceof Error ? error.name : '';
        if (errorName === 'ConversationTurnRejectedError') {
          throw acp.RequestError.invalidParams(
            undefined,
            `Steering was not delivered to the active ACP prompt Turn: ${cause}`,
          );
        }
        throw acp.RequestError.internalError(undefined, cause);
      }
    };
    const unexpectedSteerResultError = (
      result: Awaited<ReturnType<TuiAcpRuntime['steer']>>,
    ): acp.RequestError => {
      if (result.mode === 'activated') {
        void result.completion.catch(() => undefined);
        return acp.RequestError.invalidParams(
          undefined,
          'Steering cannot activate a new Turn for an ACP prompt.',
        );
      }
      return acp.RequestError.invalidParams(
        undefined,
        'The steer result did not match the active ACP prompt Turn.',
      );
    };
    const expectedTurnId = options.activePromptTurnId(params.sessionId);
    if (expectedTurnId) {
      const result = await steerViaRuntime({
        sessionId: params.sessionId,
        source: 'api',
        message: { content: params.text },
        producerId: 'mcode-acp',
        idempotencyKey: params.clientRequestId ?? createRequestId(),
        expectActiveTurnId: expectedTurnId,
      });
      // The durable receipt is the AUTHORITATIVE answer to a replayed
      // clientRequestId: its original Turn may since have finished or been
      // superseded, so a duplicate reports that Turn as-is instead of
      // matching the currently active one. Only a NEW delivery ('steered')
      // must join the Turn this prompt pinned.
      if (
        result.mode === 'activated' ||
        (result.mode !== 'duplicate' && result.turnId !== expectedTurnId)
      ) {
        throw unexpectedSteerResultError(result);
      }
      return { turnId: result.turnId, mode: result.mode };
    }
    if (!params.clientRequestId) {
      throw acp.RequestError.invalidParams(
        undefined,
        'Steering requires an admitted, active ACP prompt Turn for this Session.',
      );
    }
    // No admitted prompt Turn for a NEW delivery — but a replayed
    // clientRequestId is answered by its durable receipt, which outlives the
    // prompt and its Turn (finished Turn, later Turn, reconnected client).
    // Probe the receipt read-only (receiptLookupOnly can neither deliver nor
    // activate a Turn); with no receipt the request is still refused and
    // consumes nothing.
    const probed = await steerViaRuntime({
      sessionId: params.sessionId,
      source: 'api',
      message: { content: params.text },
      producerId: 'mcode-acp',
      idempotencyKey: params.clientRequestId,
      receiptLookupOnly: true,
    });
    if (probed.mode !== 'duplicate') throw unexpectedSteerResultError(probed);
    return { turnId: probed.turnId, mode: probed.mode };
  });

  options.app.onRequest('mcode/session/queue/list', parseSessionRequest, async ({ params }) => {
    await resolvePersisted(params.sessionId);
    return { items: await options.runtime.listQueuedMessages(params.sessionId) };
  });

  options.app.onRequest('mcode/session/queue/enqueue', parseTextRequest, async ({ params }) => {
    await resolvePersisted(params.sessionId);
    return options.runtime.enqueueMessage(params.sessionId, params.text);
  });

  options.app.onRequest('mcode/session/queue/update', parseQueueTextRequest, async ({ params }) => {
    await resolvePersisted(params.sessionId);
    return {
      item:
        (await options.runtime.updateQueuedMessageContent(
          params.sessionId,
          params.itemId,
          params.text,
        )) ?? null,
    };
  });

  options.app.onRequest('mcode/session/queue/delete', parseQueueItemRequest, async ({ params }) => {
    await resolvePersisted(params.sessionId);
    return {
      item: (await options.runtime.deleteQueuedMessage(params.sessionId, params.itemId)) ?? null,
    };
  });

  options.app.onRequest('mcode/session/queue/steer', parseQueueItemRequest, async ({ params }) => {
    await resolvePersisted(params.sessionId);
    return options.runtime.steerQueuedMessage(params.sessionId, params.itemId);
  });

  // Durable liveness probe (incident 2026-11-15: a kagero run sat six
  // minutes on "active" with zero wire events and no cheap way to tell a
  // thinking model from a stalled stream). Resolves the session like the
  // queue family — an integrator polls THIS after a resume, on a session
  // another process created — and answers with the admitted active Turn,
  // the latest durable turn activity, and the queue depth in one read.
  options.app.onRequest('mcode/session/turn_status', parseSessionRequest, async ({ params }) => {
    await resolvePersisted(params.sessionId);
    const [turnStatus, queue] = await Promise.all([
      options.runtime.getTurnStatus?.(params.sessionId),
      options.runtime.getQueueSnapshot(params.sessionId),
    ]);
    return {
      activeTurn: turnStatus?.activeTurn ?? null,
      latestActivity: turnStatus?.latestActivity ?? null,
      queue: { pendingCount: queue.pendingCount, paused: queue.paused },
    };
  });

  options.app.onRequest('mcode/session/turn_result', (value) => {
    const record = requireRecord(value);
    return {
      sessionId: requireText(record.sessionId, 'sessionId'),
      turnId: requireText(record.turnId, 'turnId'),
    };
  }, async ({ params }) => {
    const session = await resolvePersisted(params.sessionId);
    const status = await options.runtime.getTurnStatus?.(params.sessionId, params.turnId);
    const activity = status?.latestActivity;
    if (activity?.turnId !== params.turnId) return { status: 'missing' };
    if (!activity.outcome) return { status: 'pending' };
    if (activity.outcome === 'failed') {
      return { status: 'failed', reason: activity.failureReason ?? null };
    }
    if (activity.outcome === 'aborted') return { status: 'aborted' };
    if (await pendingQuestionnaireForTurn(options.runtime, params.sessionId, params.turnId, session.agentName)) {
      return { status: 'pending' };
    }
    const answer = await readCommittedTurnAnswer(options.runtime, params.sessionId, params.turnId);
    return { status: 'completed', answer };
  });

  // The built-in tool surface of one Session: the stable catalog (name +
  // source) and the effective set its policy keeps. Read-only; the policy
  // itself rides session/new|load|resume `_meta["minimax-code/toolPolicy"]`.
  options.app.onRequest('mcode/session/tools', parseSessionRequest, async ({ params }) => {
    const session = resolve(params.sessionId);
    return readTuiAcpSessionTools(options.runtime, session.sessionId);
  });

  options.app.onRequest('mcode/session/goal/get', parseSessionRequest, async ({ params }) => {
    requireGoalEnabled();
    resolve(params.sessionId);
    return { goal: (await options.runtime.getGoal(params.sessionId)) ?? null };
  });

  options.app.onRequest('mcode/session/goal/create', parseGoalCreateRequest, async ({ params }) => {
    requireGoalEnabled();
    resolve(params.sessionId);
    return {
      goal: await options.runtime.createGoal({
        sessionId: params.sessionId,
        objective: params.objective,
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
      }),
    };
  });

  options.app.onRequest('mcode/session/goal/patch', parseGoalPatchRequest, async ({ params }) => {
    requireGoalEnabled();
    resolve(params.sessionId);
    return {
      goal: await options.runtime.patchGoal(params.sessionId, {
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.objective !== undefined ? { objective: params.objective } : {}),
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
      }),
    };
  });

  options.app.onRequest('mcode/session/goal/clear', parseSessionRequest, async ({ params }) => {
    requireGoalEnabled();
    resolve(params.sessionId);
    return { cleared: await options.runtime.clearGoal(params.sessionId) };
  });

  options.app.onRequest('mcode/session/delegation/get', parseSessionRequest, async ({ params }) => {
    const session = resolve(params.sessionId);
    const rootSessionId = await resolveRootSessionId(options.runtime, session);
    return { snapshot: await options.runtime.getDelegationSnapshot(rootSessionId) };
  });

  options.app.onRequest(
    'mcode/session/delegation/stop',
    parseSessionRequest,
    async ({ params }) => {
      const session = resolve(params.sessionId);
      const rootSessionId = await resolveRootSessionId(options.runtime, session);
      return { receipt: await options.runtime.stopDelegation(rootSessionId) };
    },
  );
}

export function supportsTuiAcpExtensionNotifications(
  capabilities: acp.ClientCapabilities,
): boolean {
  const extension = capabilities._meta?.['minimax-code/extensions'];
  return (
    extension === true ||
    (isRecord(extension) &&
      extension.version === TUI_ACP_EXTENSION_VERSION &&
      extension.notifications === true)
  );
}

export async function resolveRootSessionId(
  runtime: Pick<TuiAcpRuntime, 'getSession'>,
  session: TuiSession,
): Promise<string> {
  let current = session;
  const visited = new Set<string>();
  while (current.parentSessionId) {
    if (visited.has(current.sessionId)) {
      throw acp.RequestError.internalError(undefined, 'Session parent chain contains a cycle.');
    }
    visited.add(current.sessionId);
    current = await runtime.getSession(current.parentSessionId);
  }
  return current.sessionId;
}

async function readCommittedTurnAnswer(
  runtime: TuiAcpRuntime,
  sessionId: string,
  turnId: string,
): Promise<string | null> {
  let before: string | undefined;
  for (;;) {
    const page = await runtime.listMessagePage(sessionId, { limit: 100, ...(before ? { before } : {}) });
    const lastAssistant = page.messages.findLast((message) =>
      message.turnId === turnId && message.role === 'assistant' &&
      (message.kind === undefined || message.kind === 'final' || message.kind === 'preamble'),
    );
    if (lastAssistant) {
      const final = lastAssistant.kind === 'final' ||
        ['stop', 'end_turn', 'stop_sequence'].includes(lastAssistant.finishReason ?? '');
      if (!final || lastAssistant.kind === 'preamble' || lastAssistant.toolCalls?.length) return null;
      return lastAssistant.content?.trim() ? lastAssistant.content : null;
    }
    if (!page.hasMore || !page.nextCursor || page.nextCursor === before) return null;
    before = page.nextCursor;
  }
}

function requireSession(
  resolveSession: (sessionId: string) => TuiSession | undefined,
  sessionId: string,
): TuiSession {
  const session = resolveSession(sessionId);
  if (!session) throw acp.RequestError.resourceNotFound(sessionId);
  return session;
}

function parseSessionRequest(value: unknown): { sessionId: string } {
  const record = requireRecord(value);
  return { sessionId: requireText(record.sessionId, 'sessionId') };
}

function parseTextRequest(value: unknown): {
  sessionId: string;
  text: string;
  clientRequestId?: string;
} {
  const record = requireRecord(value);
  const text = requireMessageText(record.text, 'text');
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    text,
    ...(record.clientRequestId === undefined
      ? {}
      : { clientRequestId: requireText(record.clientRequestId, 'clientRequestId') }),
  };
}

function parseQueueItemRequest(value: unknown): { sessionId: string; itemId: string } {
  const record = requireRecord(value);
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    itemId: requireText(record.itemId, 'itemId'),
  };
}

function parseQueueTextRequest(value: unknown): {
  sessionId: string;
  itemId: string;
  text: string;
} {
  return {
    ...parseQueueItemRequest(value),
    text: requireMessageText(requireRecord(value).text, 'text'),
  };
}

function parseGoalCreateRequest(value: unknown): {
  sessionId: string;
  objective: string;
  tokenBudget?: number | null;
} {
  const record = requireRecord(value);
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    objective: requireText(record.objective, 'objective'),
    ...(record.tokenBudget === undefined
      ? {}
      : { tokenBudget: optionalBudget(record.tokenBudget, 'tokenBudget') }),
  };
}

const GOAL_STATUSES = ['active', 'paused', 'blocked', 'complete', 'budget_limited'] as const;
type GoalStatus = (typeof GOAL_STATUSES)[number];

function parseGoalPatchRequest(value: unknown): {
  sessionId: string;
  status?: GoalStatus;
  objective?: string;
  tokenBudget?: number | null;
} {
  const record = requireRecord(value);
  const status = record.status;
  if (status !== undefined && !GOAL_STATUSES.some((candidate) => candidate === status)) {
    throw acp.RequestError.invalidParams(undefined, 'status is not a supported Goal status.');
  }
  const patch = {
    ...(status === undefined ? {} : { status: status as GoalStatus }),
    ...(record.objective === undefined
      ? {}
      : { objective: requireText(record.objective, 'objective') }),
    ...(record.tokenBudget === undefined
      ? {}
      : { tokenBudget: optionalBudget(record.tokenBudget, 'tokenBudget') }),
  };
  if (Object.keys(patch).length === 0) {
    throw acp.RequestError.invalidParams(undefined, 'Goal patch must change at least one field.');
  }
  return { sessionId: requireText(record.sessionId, 'sessionId'), ...patch };
}

function optionalBudget(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw acp.RequestError.invalidParams(undefined, `${label} must be null or a positive number.`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw acp.RequestError.invalidParams(undefined, `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireMessageText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw acp.RequestError.invalidParams(undefined, `${label} must be a non-empty string.`);
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw acp.RequestError.invalidParams(undefined, 'Extension params must be an object.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
