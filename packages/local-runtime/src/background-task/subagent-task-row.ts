import type { LocalRuntimeToolContext, LocalTaskToolInput } from '@mavis/agent-tools/desktop';

import type { LocalTaskTargetFacts } from '../agent/port.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import type { BackgroundTask } from './domain.js';

/**
 * How the owner Turn drives this subagent task. It stays metadata: the task
 * state machine and its domain enums are identical for all three modes.
 */
export type LocalSubagentTaskExecutionMode = 'foreground' | 'background' | 'append';

/**
 * Creates the `queued` row shared by every local subagent task so a foreground
 * run is as observable and as recoverable as a background one: it has a taskId
 * handle, an output log, and a row that startup reconciliation can mark `lost`.
 * A reactive foreground run also records its durable wait identity
 * (`nativeWaitId`), so recovery can join the seam outcome with the canonical
 * result by turn/toolCallId exactly once (verdict 09 §1.8).
 */
export function createLocalSubagentTaskRow(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  turnId: string;
  executionMode: LocalSubagentTaskExecutionMode;
  ownerSessionId: string;
  toolCtx: LocalRuntimeToolContext;
  taskInput: LocalTaskToolInput;
  target: LocalTaskTargetFacts;
  nativeWaitId?: string;
}): Promise<BackgroundTask> {
  const now = input.host.nowMs();
  return input.host.backgroundTaskService.create({
    taskId: input.taskId,
    kind: 'subagent',
    status: 'queued',
    ownerSessionId: input.ownerSessionId,
    description: input.taskInput.description,
    toolCallId: input.toolCtx.toolCallId,
    createdAt: now,
    updatedAt: now,
    metadata: {
      parentSessionId: input.ownerSessionId,
      parentTurnId: input.toolCtx.turnId,
      agentName: input.target.resolvedAgentName,
      requestedAgentName: input.target.requestedName,
      exactOwnerName: input.target.exactOwnerName,
      resolvedAgentName: input.target.resolvedAgentName,
      trustedBuiltin: input.target.trustedBuiltin,
      subTurnId: input.turnId,
      executionMode: input.executionMode,
      ...(input.nativeWaitId ? { nativeWaitId: input.nativeWaitId } : {}),
      ...(input.target.canonicalRole ? { canonicalRole: input.target.canonicalRole } : {}),
    },
  });
}
