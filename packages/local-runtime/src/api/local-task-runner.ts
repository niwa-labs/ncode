import type {
  LocalRuntimeToolContext,
  LocalTaskAdapter,
  LocalTaskForegroundWaitResult,
  LocalTaskRunResult,
  LocalTaskToolInput,
} from '@mavis/agent-tools/desktop';

import { createSubagentFinishTelemetrySink } from '../agent/subagent-telemetry.js';
import { admitBackgroundTask } from '../background-task/lifecycle.js';
import { createBackgroundTaskId } from '../background-task/domain.js';
import { startBackgroundLocalTask } from '../background-task/runner.js';
import { createLocalSubagentTaskRow } from '../background-task/subagent-task-row.js';
import { persistLocalSubagentTaskTerminal } from '../background-task/terminal.js';
import { taskTurnId } from '../background-task/turn-id.js';
import { logger } from '../common/logger.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { runInjectedConversationTaskTurn } from './injected-conversation-task-turn.js';
import type { LocalTaskRunnerHostWithSessionLookup } from './local-task-host.js';
import { requireTaskConversation } from './local-task-host.js';
import { normalizeLocalTaskInput, taskModelSelectionFor } from './local-task-input.js';
import { resolveLocalTaskAgentTarget } from './local-task-subagents.js';
import { nativeTaskWaitId } from './native-task-wait.js';
import { resolveV2SessionArtifactPathsSync } from '../persistence/layout/v2-session-artifacts.js';

export type {
  LocalTaskRunnerHost,
  LocalTaskRunnerHostWithSessionLookup,
} from './local-task-host.js';

export function buildLocalTaskAdapter(
  host: LocalTaskRunnerHostWithSessionLookup,
  parentSession: LocalSessionRecord,
): LocalTaskAdapter {
  return {
    runForeground: (toolCtx, taskInput, signal) =>
      runForegroundLocalTask({ host, parentSession, toolCtx, taskInput, signal }),
    startBackground: (toolCtx, taskInput, signal) =>
      startBackgroundLocalTask({ host, parentSession, toolCtx, taskInput, signal }),
    runReactiveForeground: (toolCtx, taskInput, signal) =>
      runReactiveForegroundLocalTask({ host, parentSession, toolCtx, taskInput, signal }),
  };
}

export async function runForegroundLocalTask(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  parentSession: LocalSessionRecord;
  toolCtx: LocalRuntimeToolContext;
  taskInput: LocalTaskToolInput;
  /** Submitter-owned provenance forwarded verbatim into the child Turn's origin. */
  origin?: unknown;
  /** Best-effort observation after the child Session becomes queryable. */
  onChildStarted?: (input: { readonly subSessionId: string; readonly subTurnId: string }) => void;
  signal?: AbortSignal;
}): Promise<LocalTaskRunResult> {
  if (input.signal?.aborted) throw new Error('Operation aborted');
  const taskInput = normalizeLocalTaskInput(input.taskInput);
  const conversation = requireTaskConversation(input.host);
  const target = await resolveLocalTaskAgentTarget(
    input.host,
    taskInput.agent_name,
    input.toolCtx.pluginAgents,
  );
  if (!target) {
    // No runnable target, so there is nothing to track: the failure carries no
    // task handle because no task row was ever created.
    return {
      status: 'failed',
      requestedAgentName: taskInput.agent_name,
      errorMessage: `Unknown agent: ${taskInput.agent_name}`,
    };
  }
  const agentName = target.resolvedAgentName;
  const taskModelSelection = taskModelSelectionFor(taskInput);

  // A foreground run uses the same task state machine as a background one, so
  // an exception anywhere below still leaves a terminal row with an output the
  // owner can re-read through task_output.
  const taskId = createBackgroundTaskId();
  const turnId = taskTurnId(taskId);
  await createLocalSubagentTaskRow({
    host: input.host,
    taskId,
    turnId,
    executionMode: 'foreground',
    ownerSessionId: input.parentSession.sessionId,
    toolCtx: input.toolCtx,
    taskInput,
    target,
  });

  let childSession: LocalSessionRecord | undefined;
  try {
    childSession = await input.host.agentRoutes.createSession({
      // Upstream runs plugin-declared delegates under the builtin `worker`
      // role; the declaration itself rides into the binding capture.
      agentName: target.pluginAgent ? 'worker' : agentName,
      ...(target.pluginAgent ? { taskPluginAgent: target.pluginAgent } : {}),
      workspaceDir: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
      sessionType: 'branch',
      sessionKind: 'task',
      parentSessionId: input.parentSession.sessionId,
      title: taskInput.description,
      visibility: 'hidden',
      purpose: `local-task:${input.toolCtx.turnId}:${input.toolCtx.toolCallId ?? 'tool'}`,
      runLocation: input.parentSession.runLocation,
      appMode: input.parentSession.appMode,
      isDefaultWorkspace: input.parentSession.isDefaultWorkspace,
      ...(taskModelSelection ? { taskModelSelection } : {}),
    });
    input.host.sessionPermissionModes?.inherit(
      childSession.sessionId,
      input.parentSession.sessionId,
    );
    await input.host.backgroundTaskService.patch(taskId, {
      status: 'running',
      startedAt: input.host.nowMs(),
      metadata: { childSessionId: childSession.sessionId, subTurnId: turnId, agentName },
    });
    try {
      input.onChildStarted?.({ subSessionId: childSession.sessionId, subTurnId: turnId });
    } catch {
      // Diagnostic observation must never change task execution.
    }
    const pluginStartContext = await input.toolCtx.pluginSubagentLifecycle?.start(
      {
        childSessionId: childSession.sessionId,
        childTurnId: turnId,
        agentId: childSession.sessionId,
        agentType: agentName,
        agentTranscriptPath: resolveV2SessionArtifactPathsSync(
          input.host.configGetter().dataDir,
          childSession.sessionId,
          { createdAtMs: childSession.createdAtMs },
        ).display,
      },
      input.signal,
    );
    const result = await runInjectedConversationTaskTurn({
      conversation,
      childSession,
      turnId,
      prompt: appendPluginHookContext(taskInput.prompt, pluginStartContext),
      source: 'task',
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      requestedAgentName: target.requestedName,
      resolvedAgentName: agentName,
      ...(target.canonicalRole === 'verifier' && target.trustedBuiltin
        ? { agentRole: 'verifier' as const }
        : {}),
      onFinish: createSubagentFinishTelemetrySink(
        input.host,
        target.canonicalRole ?? target.resolvedAgentName,
        'foreground',
      ),
      signal: input.signal,
    });
    await finalizeForegroundTask(input.host, taskId, result, turnId);
    if (result.status !== 'succeeded') {
      input.toolCtx.pluginSubagentLifecycle?.cancel(childSession.sessionId);
    }
    return { ...result, taskId };
  } catch (error) {
    if (childSession) input.toolCtx.pluginSubagentLifecycle?.cancel(childSession.sessionId);
    const failure: LocalTaskRunResult = {
      status: 'failed',
      requestedAgentName: target.requestedName,
      resolvedAgentName: agentName,
      ...(childSession ? { subSessionId: childSession.sessionId } : {}),
      subTurnId: turnId,
      errorMessage: error instanceof Error ? error.message : String(error),
      taskId,
    };
    await finalizeForegroundTask(input.host, taskId, failure, turnId);
    return failure;
  }
}

function appendPluginHookContext(prompt: string, context: string | undefined): string {
  return context?.trim()
    ? `${prompt}\n\n<plugin-hook-context>\n${context.trim()}\n</plugin-hook-context>`
    : prompt;
}

/**
 * Reactive foreground task (verdict 09 §1.4–1.6, wave 2): the child execution
 * and the parent tool wait are SEPARATE lifetimes.
 *
 * - The execution starts exactly once, under a task-owned controller, and is
 *   adopted by the background-task admission (`admitBackgroundTask`): its
 *   promise lives to terminal regardless of when the tool call returns, and a
 *   parent-turn abort after release does not cancel it (§4: internal parent
 *   cancellation never kills a detached child).
 * - The task tool waits on the native wait handle. While the wait is
 *   foreground, a parent-tool abort proxies into the child (same behaviour as
 *   the legacy path). Once the wait releases, the proxy is dead: the child
 *   keeps the same session/turn/taskId and its terminal reaches the owner
 *   through the scheduled background delivery.
 * - The ONE result decision is the durable seam's (§1.8): an inline completion
 *   commits `finalizeTool` with the real result while the wait is foreground;
 *   a release commits the prepared background outcome. The loser of the race
 *   reads the authoritative outcome and routes the terminal accordingly —
 *   never two tool-results, never a fake terminal for a running child.
 *
 * Without `host.nativeTaskWaits` (jsonl mode, embeddings) this delegates to
 * the legacy {@link runForegroundLocalTask} and the wait always completes
 * inline — the reactive capability is honestly absent there (§5.2).
 */
export async function runReactiveForegroundLocalTask(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  parentSession: LocalSessionRecord;
  toolCtx: LocalRuntimeToolContext;
  taskInput: LocalTaskToolInput;
  signal?: AbortSignal;
}): Promise<LocalTaskForegroundWaitResult> {
  if (!input.host.nativeTaskWaits || !input.toolCtx.toolCallId) {
    return { kind: 'completed', result: await runForegroundLocalTask(input) };
  }
  if (input.signal?.aborted) throw new Error('Operation aborted');
  const taskInput = normalizeLocalTaskInput(input.taskInput);
  const conversation = requireTaskConversation(input.host);
  const target = await resolveLocalTaskAgentTarget(
    input.host,
    taskInput.agent_name,
    input.toolCtx.pluginAgents,
  );
  if (!target) {
    return {
      kind: 'completed',
      result: {
        status: 'failed',
        requestedAgentName: taskInput.agent_name,
        errorMessage: `Unknown agent: ${taskInput.agent_name}`,
      },
    };
  }
  const agentName = target.resolvedAgentName;
  const taskModelSelection = taskModelSelectionFor(taskInput);
  const ownerSessionId = input.parentSession.sessionId;
  const ownerTurnId = input.toolCtx.turnId;
  const toolCallId = input.toolCtx.toolCallId;

  const taskId = createBackgroundTaskId();
  const turnId = taskTurnId(taskId);
  const waitId = nativeTaskWaitId(ownerSessionId, ownerTurnId, toolCallId);
  // A foreground run uses the same task state machine as a background one, so
  // an exception anywhere below still leaves a terminal row with an output the
  // owner can re-read through task_output. The binding identity rides in the
  // row metadata from birth, so recovery can join the seam outcome with the
  // canonical result by turn/toolCallId exactly once (§1.8).
  await createLocalSubagentTaskRow({
    host: input.host,
    taskId,
    turnId,
    executionMode: 'foreground',
    ownerSessionId,
    toolCtx: input.toolCtx,
    taskInput,
    target,
    nativeWaitId: waitId,
  });

  // Task-owned execution lifetime: aborted by runtime shutdown (admission)
  // and, only while the wait is foreground, by the parent tool abort.
  const executionController = new AbortController();
  const admission = admitBackgroundTask(input.host, (reason) =>
    executionController.abort(reason),
  );

  let childSession: LocalSessionRecord | undefined;
  let waitHandle: Awaited<
    ReturnType<NonNullable<typeof input.host.nativeTaskWaits>['registerNativeTaskWait']>
  > | undefined;
  let bound = false;
  const onParentAbort = () => {
    if (waitHandle?.isForeground()) executionController.abort(input.signal?.reason);
  };
  try {
    childSession = await input.host.agentRoutes.createSession({
      agentName: target.pluginAgent ? 'worker' : agentName,
      ...(target.pluginAgent ? { taskPluginAgent: target.pluginAgent } : {}),
      workspaceDir: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
      sessionType: 'branch',
      sessionKind: 'task',
      parentSessionId: ownerSessionId,
      title: taskInput.description,
      visibility: 'hidden',
      purpose: `local-task:${ownerTurnId}:${toolCallId}`,
      runLocation: input.parentSession.runLocation,
      appMode: input.parentSession.appMode,
      isDefaultWorkspace: input.parentSession.isDefaultWorkspace,
      ...(taskModelSelection ? { taskModelSelection } : {}),
    });
    input.host.sessionPermissionModes?.inherit(childSession.sessionId, ownerSessionId);
    await input.host.backgroundTaskService.patch(taskId, {
      status: 'running',
      startedAt: input.host.nowMs(),
      metadata: { childSessionId: childSession.sessionId, subTurnId: turnId, agentName },
    });
    // Register the foreground wait BEFORE the child turn is submitted
    // (§1.5 step 2). Idempotent; an owner input accepted during this setup is
    // replayed against the freshly registered wait instead of re-parking.
    waitHandle = await input.host.nativeTaskWaits!.registerNativeTaskWait({
      ownerSessionId,
      ownerTurnId,
      toolCallId,
      taskId,
      childSessionId: childSession.sessionId,
      childTurnId: turnId,
    });
    const pluginStartContext = await input.toolCtx.pluginSubagentLifecycle?.start(
      {
        childSessionId: childSession.sessionId,
        childTurnId: turnId,
        agentId: childSession.sessionId,
        agentType: agentName,
        agentTranscriptPath: resolveV2SessionArtifactPathsSync(
          input.host.configGetter().dataDir,
          childSession.sessionId,
          { createdAtMs: childSession.createdAtMs },
        ).display,
      },
      executionController.signal,
    );

    // The execution runs ONCE. The parent-tool abort proxies into the child
    // only while the wait is foreground; after a release the child is
    // detached from this tool call (§4) and the listener is inert.
    const startedChildSession = childSession;
    input.signal?.addEventListener('abort', onParentAbort, { once: true });

    const execution = runInjectedConversationTaskTurn({
      conversation,
      childSession,
      turnId,
      prompt: appendPluginHookContext(taskInput.prompt, pluginStartContext),
      source: 'task',
      requestedAgentName: target.requestedName,
      resolvedAgentName: agentName,
      ...(target.canonicalRole === 'verifier' && target.trustedBuiltin
        ? { agentRole: 'verifier' as const }
        : {}),
      onFinish: createSubagentFinishTelemetrySink(
        input.host,
        target.canonicalRole ?? target.resolvedAgentName,
        'foreground',
      ),
      signal: executionController.signal,
    }).finally(() => {
      input.signal?.removeEventListener('abort', onParentAbort);
    });

    // Adopt the execution into the background-task active set: the promise
    // stays observed to terminal beyond this tool call's lifetime, the task is
    // identified as runnable/stoppable by THIS runtime, and a runtime shutdown
    // aborts the task-owned controller (§1.5: no execution outside admission).
    const activeWaitHandle = waitHandle;
    const lifetime = (async () => {
      let result: LocalTaskRunResult;
      try {
        result = await execution;
      } catch (error) {
        result = {
          status: 'failed',
          requestedAgentName: target.requestedName,
          resolvedAgentName: agentName,
          subSessionId: startedChildSession.sessionId,
          subTurnId: turnId,
          errorMessage: error instanceof Error ? error.message : String(error),
          taskId,
        };
      }
      if (result.status !== 'succeeded') {
        input.toolCtx.pluginSubagentLifecycle?.cancel(startedChildSession.sessionId);
      }
      // The ONE channel decision (§1.8): the seam picks inline vs background.
      const channel = await activeWaitHandle.complete(result);
      if (channel === 'inline') {
        await finalizeForegroundTask(input.host, taskId, result, turnId);
      } else {
        await persistScheduledTerminal(input.host, taskId, result, turnId);
      }
      return { result };
    })();
    admission.identify(taskId);
    admission.bind(lifetime.then(() => undefined));
    bound = true;
    void lifetime.catch((error: unknown) => {
      logger.warn(
        { sessionId: childSession?.sessionId ?? '', turnId, taskId, error },
        'Reactive foreground task lifetime failed after the wait resolved',
      );
    });

    // The wait resolves exactly once: completed (the child terminal committed
    // inline) or backgrounded (a release won). A `completed` outcome implies
    // the execution already settled, so awaiting it here is immediate.
    const outcome = await waitHandle.outcome;
    input.signal?.removeEventListener('abort', onParentAbort);
    if (outcome.kind === 'backgrounded') {
      return {
        kind: 'backgrounded',
        taskId,
        reason: outcome.reason,
        ...(childSession ? { subSessionId: childSession.sessionId } : {}),
        subTurnId: turnId,
        taskStatus: outcome.taskStatus,
      };
    }
    const settled = await lifetime;
    input.signal?.removeEventListener('abort', onParentAbort);
    return { kind: 'completed', result: settled.result };
  } catch (error) {
    input.signal?.removeEventListener('abort', onParentAbort);
    if (childSession) input.toolCtx.pluginSubagentLifecycle?.cancel(childSession.sessionId);
    const failure: LocalTaskRunResult = {
      status: 'failed',
      requestedAgentName: target.requestedName,
      resolvedAgentName: agentName,
      ...(childSession ? { subSessionId: childSession.sessionId } : {}),
      subTurnId: turnId,
      errorMessage: error instanceof Error ? error.message : String(error),
      taskId,
    };
    await finalizeForegroundTask(input.host, taskId, failure, turnId);
    if (!bound) admission.release();
    return { kind: 'completed', result: failure };
  }
}

/**
 * Terminal persistence for a RELEASED task: the background note already told
 * the model the truth ("moved to background"), so the terminal arrives through
 * the scheduled delivery — never a second inline tool-result (§1.8).
 */
async function persistScheduledTerminal(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
  result: LocalTaskRunResult,
  turnId: string,
): Promise<void> {
  try {
    await persistLocalSubagentTaskTerminal({
      host,
      taskId,
      result,
      delivery: 'schedule',
    });
  } catch (error) {
    host.matrixLogger?.warn(
      { sessionId: result.subSessionId ?? '', turnId },
      `Local released task ${taskId} could not persist its terminal state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * The foreground tool result is already the owner-visible delivery, so the row
 * is latched as delivered and must never produce a second
 * background-task-finished wake-up.
 */
async function finalizeForegroundTask(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
  result: LocalTaskRunResult,
  turnId: string,
): Promise<void> {
  try {
    await persistLocalSubagentTaskTerminal({
      host,
      taskId,
      result,
      delivery: 'already-delivered',
    });
  } catch (error) {
    // Persistence is the only failure that cannot be reported through the task
    // row itself; the run result still reaches the owner synchronously.
    host.matrixLogger?.warn(
      { sessionId: result.subSessionId ?? '', turnId },
      `Local foreground task ${taskId} could not persist its terminal state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
