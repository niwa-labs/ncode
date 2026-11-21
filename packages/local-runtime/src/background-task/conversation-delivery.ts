import { createHash } from 'node:crypto';
import {
  ConversationTurnRejectedError,
  type RuntimeConversation,
  type ConversationSteerInput,
} from '@mavis/conversation-contract';

import { makeId } from '../api/host-helpers.js';
import { observeSteerCompletion } from '../api/conversation-steer.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import type { BackgroundTask } from './domain.js';
import { reserveDeliveryActivationTurn } from './delivery-burst.js';

export async function startConversationBackgroundTaskDeliveryTurn(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  conversation: RuntimeConversation;
  ownerSessionId: string;
  tasks: readonly BackgroundTask[];
  observedTerminalCount: number;
}): Promise<'delivered' | 'busy' | 'failed' | 'deferred'> {
  const { host, conversation, ownerSessionId, tasks, observedTerminalCount } = input;
  try {
    const requestedTurnId = makeId('turn_task_delivery');
    // Owner override of verdict 09 §3.1 (2026-11-06): the wake envelope carries
    // each task's full result body so the model can answer without spending an
    // extra turn on `task_output`. The read rides the SAME output store the
    // tool reads; a failed read only drops the body (the tool stays the
    // fallback), never the notification itself.
    const outputs = await readTaskOutputBodies(host, tasks);
    const steered = await conversation.ingress.steer({
      ...buildBackgroundTaskDeliveryInput({
        ownerSessionId,
        tasks,
        observedTerminalCount,
        requestedTurnId,
        outputs,
      }),
      // §3.3 item 3: the burst budget gates NEW autonomous activations only.
      // The authoritative admission mode arrives here before anything is
      // delivered, so a delivery that would JOIN an already-active owner Turn
      // is never rate-limited (batch bounds + the retry-stable idempotency key
      // bound it instead), and a delivery that would WAKE an idle session
      // consumes the 3/60s storm guard exactly once. Throwing inside `accept`
      // rejects the admission before delivery — the same rejection path
      // `task_append` uses — and the scheduler trails the batch to the
      // window's release.
      preDelivery: {
        accept: ({ mode }) => {
          if (mode !== 'activated') return;
          if (reserveActivationTurn(host, ownerSessionId) === undefined) {
            throw new LocalBackgroundDeliveryBurstDeferredError();
          }
        },
      },
    });
    // Delivery only needs the admission ACK; the owner Turn keeps running.
    observeSteerCompletion(steered, {
      sessionId: ownerSessionId,
      producer: 'Local background task delivery',
      ...(host.matrixLogger ? { matrixLogger: host.matrixLogger } : {}),
    });
    try {
      host.metricsClient?.counter('background_task_delivery_admitted_total', 1, {
        mode: steered.mode,
      });
    } catch {
      // Telemetry must not turn an admitted notification into a failure.
    }
    return 'delivered';
  } catch (error) {
    if (error instanceof LocalBackgroundDeliveryBurstDeferredError) return 'deferred';
    if (error instanceof ConversationTurnRejectedError) return 'busy';
    try {
      host.matrixLogger?.warn(
        { sessionId: ownerSessionId, turnId: batchDeliveryIdentity(tasks) },
        `Local background task delivery failed for ${tasks
          .map((task) => task.taskId)
          .join(', ')}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Diagnostic failures must not change the transport result or abandon retries.
    }
    return 'failed';
  }
}

/**
 * Deliberate, bounded suppression of an idle wake (§3.3 item 4): the session's
 * autonomous-activation storm guard is exhausted for the current 60s window.
 * Never a transport failure — the scheduler trails the batch to the exact
 * window release and delivers every accumulated terminal there.
 */
export class LocalBackgroundDeliveryBurstDeferredError extends Error {
  constructor() {
    super('Local background delivery exceeded the autonomous activation storm guard');
    this.name = 'LocalBackgroundDeliveryBurstDeferredError';
  }
}

function reserveActivationTurn(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
): { windowStartedAt: number; delivered: number } | undefined {
  return reserveDeliveryActivationTurn(host, ownerSessionId);
}

export function buildBackgroundTaskDeliveryInput(input: {
  ownerSessionId: string;
  tasks: readonly BackgroundTask[];
  observedTerminalCount: number;
  requestedTurnId: string;
  /** Result bodies keyed by taskId; the batch byte bounds still measure the metadata envelope only. */
  outputs?: ReadonlyMap<string, string>;
}): ConversationSteerInput {
  return {
    sessionId: input.ownerSessionId,
    source: 'background-task',
    requestedTurnId: input.requestedTurnId,
    producerId: 'background-task-delivery',
    idempotencyKey: batchDeliveryIdentity(input.tasks),
    message: {
      content: buildBackgroundTaskDeliveryPrompt(input.tasks, input.outputs),
      attachments: [],
      hideUserMessage: true,
      origin: {
        kind: 'background-task-terminal',
        taskIds: input.tasks.map((task) => task.taskId),
        observedTerminalCount: input.observedTerminalCount,
      },
    },
  };
}

/**
 * Retry-stable idempotency key of one delivery batch (§3.1): the identity of
 * the terminal RUNS, not just their task rows. Each entry is
 * `taskId` plus the terminal child-turn generation (`metadata.subTurnId`)
 * when the row records one — repeated `task_append` work creates new rows/runs
 * under the same conversation, and each generation must be deliverable even
 * though an earlier run of the same conversation already delivered. Rows
 * without a recorded generation keep the legacy key shape, so retries of
 * one-shot tasks stay byte-identical.
 */
export function batchDeliveryIdentity(tasks: readonly BackgroundTask[]): string {
  const keys = tasks.map((task) => deliveryRunKey(task));
  if (keys.length === 1 && keys[0]) return keys[0];
  const digest = createHash('sha256')
    .update(JSON.stringify(keys.sort()))
    .digest('hex');
  return `background-task-batch:${digest}`;
}

/** The terminal-run identity of one task row: `taskId` + its terminal child turn, if recorded. */
function deliveryRunKey(task: BackgroundTask): string {
  const generation = task.metadata?.['subTurnId'];
  return typeof generation === 'string' && generation !== ''
    ? `${task.taskId}@${generation}`
    : task.taskId;
}

export function buildBackgroundTaskDeliveryPrompt(
  tasks: readonly BackgroundTask[],
  outputs?: ReadonlyMap<string, string>,
): string {
  const bodies = tasks.map((task) => buildDeliveryTaskElement(task, outputs?.get(task.taskId)));
  const anyBody = bodies.some((body) => body !== null);
  return [
    '<background-task-finished>',
    'Local background tasks have finished in this conversation.',
    ...bodies.map((body, index) => body ?? selfClosingTaskElement(tasks[index]!)),
    anyBody
      ? 'Each task\'s full output is included in its <task_output> section; use task_output with a task_id only if you need output beyond what is included, then report the relevant results to the user as a normal assistant reply in this conversation.'
      : 'Use task_output with each task_id to read the results, then report the relevant results to the user as a normal assistant reply in this conversation.',
    'Do not mention this internal notice unless it is necessary to explain the results.',
    '</background-task-finished>',
  ].join('\n');
}

function buildDeliveryTaskElement(
  task: BackgroundTask,
  output: string | undefined,
): string | null {
  // Owner rule: no invented truncation or size limit on the included body — an
  // empty output simply omits the field, exactly like the previous envelope.
  if (output === undefined || output === '') return null;
  return [
    `  <task${taskElementAttributes(task)}>`,
    '    <task_output>',
    escapeXmlText(output),
    '    </task_output>',
    '  </task>',
  ].join('\n');
}

function selfClosingTaskElement(task: BackgroundTask): string {
  return `  <task${taskElementAttributes(task)}/>`;
}

/** The shared `<task>` attributes: identity, status, and the terminal-run generation (§3.1). */
function taskElementAttributes(task: BackgroundTask): string {
  const description = task.description
    ? ` description="${escapeXmlAttribute(task.description)}"`
    : '';
  const endedAt = task.endedAt === undefined ? '' : ` ended_at_ms="${task.endedAt}"`;
  const generation = task.metadata?.['subTurnId'];
  const childTurn =
    typeof generation === 'string' && generation !== ''
      ? ` child_turn_id="${escapeXmlAttribute(generation)}"`
      : '';
  return ` task_id="${escapeXmlAttribute(task.taskId)}" status="${task.status}"${description}${endedAt}${childTurn}`;
}

/**
 * Reads every task's full output through the same store `task_output` reads.
 * Best-effort by design: a host or store that cannot serve the body (older
 * fakes, an unreadable sidecar) yields no body — the envelope keeps its
 * metadata and `task_output` remains the fallback.
 */
async function readTaskOutputBodies(
  host: LocalTaskRunnerHostWithSessionLookup,
  tasks: readonly BackgroundTask[],
): Promise<Map<string, string>> {
  const outputs = new Map<string, string>();
  const reader = host.backgroundTaskService as Partial<{
    readFullOutput(taskId: string): Promise<string>;
  }>;
  if (typeof reader.readFullOutput !== 'function') return outputs;
  await Promise.all(
    tasks.map(async (task) => {
      try {
        const body = await reader.readFullOutput!(task.taskId);
        if (body !== '') outputs.set(task.taskId, body);
      } catch (error) {
        try {
          host.matrixLogger?.warn(
            { sessionId: 'local-background-task-delivery', turnId: task.taskId },
            `Background task output body could not be included in the wake notice: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } catch {
          // A dropped body must never fail the delivery itself.
        }
      }
    }),
  );
  return outputs;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Element-content escaping for an included output body: attribute quoting is meaningless there. */
function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
