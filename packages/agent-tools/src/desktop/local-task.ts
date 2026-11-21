import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalTaskToolDef, type LocalTaskToolInput } from './builtin-defs.js';
import { formatLocalTaskParentReport } from './task-verification.js';
import type {
  LocalRuntimeToolContext,
  LocalTaskAdapter,
  LocalTaskForegroundWaitResult,
} from './types.js';
import { withPluginHookCompatibleToolResponse } from '../plugin-hooks/vendor-tool-response.js';

@bindTool(LocalTaskToolDef)
export class LocalTaskTool implements ToolImpl<
  typeof LocalTaskToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalTaskAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    if (input.run_in_background === true) {
      const started = await this.adapter.startBackground(ctx, input, signal);
      if (started.status !== 'started' || !started.taskId) {
        const errorMessage = started.errorMessage ?? 'Local background task failed to start';
        const text = `<task_error${taskIdAttribute(started.taskId)}${sessionIdAttribute(started.subSessionId)}>${errorMessage}</task_error>`;
        return {
          tool_name: LocalTaskToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details: {
            agent_name: input.agent_name,
            status: started.status,
            ...(started.taskId ? { task_id: started.taskId } : {}),
            ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
            ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
          },
          isError: true,
        };
      }

      const text = formatExplicitBackgroundNote({
        taskId: started.taskId,
        ...(started.subSessionId !== undefined ? { subSessionId: started.subSessionId } : {}),
      });
      const result: ToolResult = {
        tool_name: LocalTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          agent_name: input.agent_name,
          status: 'started',
          task_id: started.taskId,
          execution_mode: 'background',
          reason: 'run_in_background',
          ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
          ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
        },
      };
      return started.subSessionId
        ? withPluginHookCompatibleToolResponse(result, {
            status: 'async_launched',
            agentId: started.subSessionId,
            description: input.description,
            prompt: input.prompt,
          })
        : result;
    }

    if (this.adapter.runReactiveForeground) {
      const wait = await this.adapter.runReactiveForeground(ctx, input, signal);
      if (wait.kind === 'backgrounded') return this.backgroundedResult(wait, input);
      return this.completedResult(wait.result, input);
    }

    const run = await this.adapter.runForeground(ctx, input, signal);
    return this.completedResult(run, input);
  }
  /** The release branch: the single `<task_background>` note of the wait (§2.2). */
  private backgroundedResult(
    wait: Extract<LocalTaskForegroundWaitResult, { kind: 'backgrounded' }>,
    input: LocalTaskToolInput,
  ): ToolResult {
    const text = formatReleasedBackgroundNote(wait);
    const result: ToolResult = {
      tool_name: LocalTaskToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        agent_name: input.agent_name,
        status: 'backgrounded',
        task_id: wait.taskId,
        execution_mode: 'background',
        reason: wait.reason,
        automatic_notification: true,
        task_status: wait.taskStatus,
        ...(wait.subSessionId ? { sub_session_id: wait.subSessionId } : {}),
        ...(wait.subTurnId ? { sub_turn_id: wait.subTurnId } : {}),
      },
    };
    return wait.subSessionId
      ? withPluginHookCompatibleToolResponse(result, {
          status: 'async_launched',
          agentId: wait.subSessionId,
          description: input.description,
          prompt: input.prompt,
        })
      : result;
  }

  private completedResult(run: Awaited<ReturnType<LocalTaskAdapter['runForeground']>>, input: LocalTaskToolInput): ToolResult {
    if (run.status !== 'succeeded') {
      const errorMessage = run.errorMessage ?? 'Agent task failed';
      const text = `<task_error${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}>\n${formatLocalTaskParentReport(
        {
          ...run,
          errorMessage,
        },
      )}\n</task_error>`;
      return {
        tool_name: LocalTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          agent_name: input.agent_name,
          status: run.status,
          ...(run.taskId ? { task_id: run.taskId } : {}),
          ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
          ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
          ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
          requested_agent_name: run.requestedAgentName,
          ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
          ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
          ...(run.verification ? { verification: run.verification } : {}),
          error_message: errorMessage,
        },
        isError: true,
      };
    }

    const text = `<task_result${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}>\n${formatLocalTaskParentReport(run)}\n</task_result>`;
    const result: ToolResult = {
      tool_name: LocalTaskToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        agent_name: input.agent_name,
        status: 'succeeded',
        ...(run.taskId ? { task_id: run.taskId } : {}),
        ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
        ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
        ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
        requested_agent_name: run.requestedAgentName,
        ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
        ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
        ...(run.verification ? { verification: run.verification } : {}),
      },
    };
    return run.subSessionId
      ? withPluginHookCompatibleToolResponse(result, {
          status: 'completed',
          agentId: run.subSessionId,
          content: [{ type: 'text', text: run.finalText ?? '' }],
        })
      : result;
  }
}

/**
 * The first receipt carries both handles: `task_id` drives task_query /
 * task_output / task_stop, `session_id` drives session send.
 */
function taskIdAttribute(taskId: string | undefined): string {
  return taskId ? ` task_id="${escapeXmlAttribute(taskId)}"` : '';
}

function sessionIdAttribute(sessionId: string | undefined): string {
  return sessionId ? ` session_id="${escapeXmlAttribute(sessionId)}"` : '';
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'stopping']);

function taskStatusAttribute(status: string): string {
  return ` status="${escapeXmlAttribute(status)}"`;
}

/**
 * The explicit `run_in_background=true` receipt (§2.2): same reason family as
 * a release but a different trigger, so it never mentions a user message.
 */
export function formatExplicitBackgroundNote(started: {
  taskId: string;
  subSessionId?: string;
}): string {
  return `<task_background task_id="${escapeXmlAttribute(started.taskId)}" execution_mode="background" reason="run_in_background" automatic_notification="true"${sessionIdAttribute(started.subSessionId)}>\nStarted background task ${started.taskId}. The owning conversation will automatically resume when it finishes unless the user explicitly stops it; the completion notice will carry the full output, so do not call task_output with waiting unless the user explicitly asked you to wait for this task's completion in this turn. Use task_query/task_output to inspect it early and task_stop to cancel it.\n</task_background>`;
}

/**
 * The single `<task_background>` note of a released foreground wait (§2.2,
 * verbatim body): the task tool-call result IS the launch/release
 * acknowledgment, not the child's final answer.
 */
export function formatReleasedBackgroundNote(
  wait: Extract<LocalTaskForegroundWaitResult, { kind: 'backgrounded' }>,
): string {
  const stillActive = ACTIVE_STATUSES.has(wait.taskStatus);
  const lines: string[] = [];
  if (wait.reason === 'owner_input') {
    lines.push('The user sent a new message, so this task was moved to the background.');
  }
  if (stillActive) {
    lines.push(`Task ${wait.taskId} is still queued or running; it has not been canceled or completed.`);
  } else {
    lines.push(
      `Task ${wait.taskId} already reached a terminal status (${wait.taskStatus}) before the move; its completion notice is pending and will be delivered automatically.`,
    );
  }
  if (wait.reason === 'owner_input') {
    lines.push(
      "Respond to the user's latest message now. The task's terminal status will be delivered automatically to this conversation, starting a new turn if needed.",
    );
  } else {
    lines.push(
      'The task continues to run. Its terminal status will be delivered automatically to this conversation, starting a new turn if needed.',
    );
  }
  lines.push(
    'Do not wait, sleep, or repeatedly poll for this task. Use task_query/task_output only when the user asks for its current state or when a completion notice arrives. Use task_stop to cancel this task, or task_append to send it additional instructions.',
  );
  lines.push(
    'Do not repeat this task merely because it moved to the background. Avoid conflicting changes while it is still running.',
  );
  return `<task_background task_id="${escapeXmlAttribute(wait.taskId)}" execution_mode="background" reason="${escapeXmlAttribute(wait.reason)}" automatic_notification="true"${taskStatusAttribute(wait.taskStatus)}${sessionIdAttribute(wait.subSessionId)}>\n${lines.join('\n')}\n</task_background>`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
