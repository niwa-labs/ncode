import { randomUUID } from 'node:crypto';
import {
  declareToolChanges,
  failToolCallsFromTruncatedMessage,
  normalizeUnexpectedToolCall,
  type AgentContext,
  type AgentMessage,
  type AgentToolResult,
  type runAgentLoop,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  createModels,
  normalizeContext,
  withClientIdentity,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type ToolResultMessage,
  type JsonValue,
} from '@earendil-works/pi-ai';
import {
  GenerationTask,
  ToolTask,
  hook,
  type Conversation,
  type ToolExecutionResult,
  type ToolRegistration,
  type UserInput,
} from '@earendil-works/pi-durable';
import type { OrchestrationHarness } from '@mavis/durable-orchestration';
import { createLogger } from '@mavis/logging';

const log = createLogger('mcode:native-foreground');
const provider = 'mcode-foreground';
const emptyModels = createModels({ identity: { attribution: null } });
const boundaryInput: UserInput = [
  { type: 'text', text: 'MCode foreground boundary' },
];

type RunLoop = typeof runAgentLoop;
type NativeStream = Models['streamSimple'];

/**
 * Route the native task's model reference to the daemon-owned prepared transport.
 * The reference contains no credentials. An old reference cannot issue requests
 * after daemon restart, and the native tool tasks use unsafe replay semantics.
 */
export class NativeForeground {
  private readonly routes = new Map<string, Model<Api>>();
  private readonly transports = new WeakMap<Model<Api>, NativeStream>();
  readonly models: Models;

  constructor(base: Models = emptyModels) {
    this.models = {
      ...withClientIdentity(base, { attribution: null }),
      getModel: (id, modelId) =>
        id === provider ? this.routes.get(modelId) : base.getModel(id, modelId),
      streamSimple: (model, context, options) => {
        const stream = this.transports.get(model);
        return stream
          ? stream(model, context, options)
          : base.streamSimple(model, context, options);
      },
    };
  }

  loop(
    harness: OrchestrationHarness,
    resolve: () => Promise<Conversation>,
  ): RunLoop {
    return async (prompts, initial, initialConfig, emit, signal, streamFn) => {
      signal?.throwIfAborted();
      const conversation = await resolve();
      const context = harness.context;
      const runId = randomUUID();
      const route = { ...initialConfig.model };
      let current: AgentContext = {
        messages: [...initial.messages],
        tools: [...(initial.tools ?? [])],
      };
      let config = initialConfig;
      let assistant: AssistantMessage | undefined;
      let started = false;
      let requestStarted = false;
      let failure: unknown;
      let lastRound:
        Parameters<NonNullable<typeof config.finishTurn>>[0] | undefined;
      const newMessages: AgentMessage[] = [];
      const toolArgs = new Map<string, unknown>();
      const toolStarts = new Set<string>();
      const toolResults = new Map<string, AgentToolResult>();
      const toolControls = new Map<string, { terminate?: boolean }>();
      const executedTools = new Map<string, AgentToolResult>();
      let sequentialGeneration: number | undefined;
      let toolStop = false;
      let pendingInput: AgentMessage[] = [];
      let eventTail = Promise.resolve();

      async function append(message: AgentMessage) {
        await emit({ type: 'message_start', message });
        await endMessage(message);
      }

      async function endMessage(message: AgentMessage) {
        current.messages.push(message);
        newMessages.push(message);
        await emit({ type: 'message_end', message });
      }

      async function appendInputs(messages: AgentMessage[]) {
        for (const message of declareToolChanges(current, messages))
          await append(message);
      }

      async function completeRound(results: ToolResultMessage[]) {
        if (!assistant)
          throw new Error(
            'Native foreground completed a round without a response',
          );
        lastRound = {
          message: assistant,
          toolResults: results,
          context: current,
          newMessages,
        };
        const decision = await config.finishTurn?.(lastRound, signal);
        await emit({
          type: 'turn_end',
          message: assistant,
          toolResults: results,
        });
        return decision;
      }

      async function startTool(
        callId: string,
        toolName: string,
        args: unknown,
      ) {
        if (toolStarts.has(callId)) return;
        toolStarts.add(callId);
        await emit({
          type: 'tool_execution_start',
          toolCallId: callId,
          toolName,
          args,
        });
      }

      const tools: ToolRegistration<any>[] = (initial.tools ?? []).map(
        (tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
          ...(tool.prepareArguments
            ? { prepareArguments: tool.prepareArguments }
            : {}),
          ...(tool.outputSchema
            ? { structuredOutputSchema: tool.outputSchema }
            : {}),
          replay: 'unsafe',
          async execute(args, api, toolContext) {
            if (!assistant || failure)
              throw new Error(
                'Native foreground tool has no admitted assistant response',
              );
            const call = assistant.content.find(
              (item) => item.type === 'toolCall' && item.id === api.callId,
            );
            if (!call || call.type !== 'toolCall')
              throw new Error('Native foreground tool was not offered');
            const toolSignal = toolContext.abortSignal;
            toolSignal?.throwIfAborted();
            toolArgs.set(api.callId, args);
            await startTool(api.callId, tool.name, args);
            config.onToolExecutionStart?.({
              assistantMessage: assistant,
              toolCall: call,
              args,
              context: current,
            });
            const result = await tool.execute(
              api.callId,
              args,
              toolSignal,
              (partialResult) => {
                eventTail = eventTail
                  .then(async () => {
                    await emit({
                      type: 'tool_execution_update',
                      toolCallId: api.callId,
                      toolName: tool.name,
                      args,
                      partialResult,
                    });
                  })
                  .catch((error) => {
                    failure ??= error;
                  });
              },
            );
            executedTools.set(api.callId, result);
            // Harness contract (pi-durable harness/tool.ts): a model-issued
            // result with `structuredOutput` and no declared
            // `structuredOutputSchema` is dropped and reported to the host as
            // an extension fault — one ERROR per read/bash call. pi tools
            // declare `outputSchema`, but our product defs wrapping them do
            // not, so the claim pairs the value with the schema: without the
            // narrowing, the required `schema` field is a compile error.
            // Product events keep `structuredContent` regardless (see
            // afterTool).
            return nativeResult(
              {
                output: result.content,
                ...(result.details === undefined
                  ? {}
                  : { details: result.details }),
                ...(result.usage === undefined ? {} : { usage: result.usage }),
                ...(result.isError === undefined
                  ? {}
                  : { isError: result.isError }),
                ...(result.terminate ? { control: { terminate: true } } : {}),
              },
              result.structuredContent !== undefined && tool.outputSchema
                ? { value: result.structuredContent, schema: tool.outputSchema }
                : undefined,
            );
          },
        }),
      );

      const extension = {
        name: `mcode.foreground.${runId}`,
        tools,
        hooks: [
          hook(GenerationTask, {
            async beforeRequest(_request, api) {
              log.debug('Native generation request', {
                conversationId: api.conversationId,
                taskId: api.taskId,
              });
              try {
                if (requestStarted) {
                  await emit({ type: 'turn_start' });
                  const update =
                    lastRound && (await config.prepareNextTurn?.(lastRound));
                  if (update) {
                    current = update.context ?? current;
                    await appendInputs(update.messages ?? []);
                    applyUpdate(update);
                  }
                }
                const steering = pendingInput.length
                  ? pendingInput
                  : ((await config.getSteeringMessages?.()) ?? []);
                pendingInput = [];
                if (steering.length) await appendInputs(steering);
                requestStarted = true;
                const update = await config.prepareRequest?.(
                  {
                    context: current,
                    model: config.model,
                    thinkingLevel: config.reasoning ?? 'off',
                  },
                  signal,
                );
                if (update) {
                  current = update.context ?? current;
                  applyUpdate(update);
                }
                const transformed =
                  (await config.transformContext?.(current.messages, signal)) ??
                  current.messages;
                return { messages: await config.convertToLlm(transformed) };
              } catch (error) {
                failure ??= error;
                return { messages: [] };
              }
            },
            async afterResponse(message) {
              try {
                const normalized = normalizeUnexpectedToolCall(message, config);
                Object.assign(message, normalized);
                assistant = message;
                if (!started) await emit({ type: 'message_start', message });
                started = false;
                await endMessage(message);
                // Product response control may strip intent after seeing the final response.
                const calls = message.content.filter(
                  (part) => part.type === 'toolCall',
                );
                if (!calls.length && message.stopReason === 'toolUse')
                  message.stopReason = 'stop';
                if (calls.length && message.stopReason === 'stop')
                  message.stopReason = 'toolUse';
                sequentialGeneration = calls.some((call) =>
                  tools.some(
                    (tool) =>
                      tool.name === call.name &&
                      tool.executionMode === 'sequential',
                  ),
                )
                  ? await config.ownerInputGeneration?.()
                  : undefined;
                if (
                  message.stopReason === 'error' ||
                  message.stopReason === 'aborted'
                )
                  await completeRound([]);
              } catch (error) {
                failure ??= error;
                message.stopReason = 'error';
                message.errorMessage =
                  error instanceof Error ? error.message : String(error);
                message.content = message.content.filter(
                  (part) => part.type !== 'toolCall',
                );
              }
            },
            async onYield(answer) {
              try {
                const calls =
                  answer.stopReason === 'length'
                    ? answer.content.filter((part) => part.type === 'toolCall')
                    : [];
                const results = calls.length
                  ? (
                      await failToolCallsFromTruncatedMessage(calls, (event) =>
                        event.type === 'message_end'
                          ? endMessage(event.message)
                          : emit(event),
                      )
                    ).messages
                  : [];
                const decision = await completeRound(results);
                if (decision?.action === 'end') return;
                const steering = (await config.getSteeringMessages?.()) ?? [];
                if (await config.shouldStopAfterSteering?.()) return;
                pendingInput = steering.length
                  ? steering
                  : ((await config.getFollowUpMessages?.()) ?? []);
                if (
                  pendingInput.length ||
                  results.length ||
                  decision?.action === 'continue'
                )
                  return { kind: 'continue', continue: boundaryInput };
              } catch (error) {
                failure ??= error;
              }
            },
            async afterTools(_entry, results, api, toolContext) {
              try {
                await eventTail;
                const calls =
                  assistant?.content.filter(
                    (part) => part.type === 'toolCall',
                  ) ?? [];
                if (results.length !== calls.length)
                  throw new Error(
                    'Native tool round did not persist every result',
                  );
                const messages: ToolResultMessage[] = [];
                for (const id of results) {
                  const entry = await api.entry(id, toolContext);
                  const message = entry?.model?.find(
                    (item) => item.role === 'toolResult',
                  );
                  if (!message || message.role !== 'toolResult')
                    throw new Error('Native tool result is missing');
                  const { toolCallId, toolName } = message;
                  const args = toolArgs.get(toolCallId);
                  const result = {
                    ...toolResults.get(toolCallId),
                    content: message.content,
                    details:
                      toolResults.get(toolCallId)?.details ?? message.details,
                  };
                  await startTool(toolCallId, toolName, args);
                  await emit({
                    type: 'tool_execution_end',
                    toolCallId,
                    toolName,
                    result,
                    isError: message.isError,
                    ...(message.durationMs === undefined
                      ? {}
                      : { durationMs: message.durationMs }),
                  });
                  await append(message);
                  messages.push(message);
                  toolArgs.delete(toolCallId);
                  toolStarts.delete(toolCallId);
                  toolResults.delete(toolCallId);
                  toolControls.delete(toolCallId);
                  executedTools.delete(toolCallId);
                }
                const decision = await completeRound(messages);
                if (toolStop || decision?.action === 'end')
                  return { terminate: true };
                pendingInput = (await config.getSteeringMessages?.()) ?? [];
                if (await config.shouldStopAfterSteering?.())
                  return { terminate: true };
              } catch (error) {
                failure ??= error;
                return { terminate: true };
              }
            },
          }),
          hook(ToolTask, {
            async beforeTool(call, _api, toolContext) {
              if (failure || !assistant)
                return { block: 'Foreground response was not admitted' };
              if (toolStop) return { block: 'Foreground turn stopped' };
              const callIndex = assistant.content
                .filter((part) => part.type === 'toolCall')
                .findIndex((part) => part.id === call.id);
              if (
                callIndex > 0 &&
                sequentialGeneration !== undefined &&
                (await config.ownerInputGeneration?.()) !== sequentialGeneration
              ) {
                return {
                  block:
                    'New user input arrived during this round. Reconsider this call against the new instruction.',
                };
              }
              toolArgs.set(call.id, call.arguments);
              const result = await config.beforeToolCall?.(
                {
                  assistantMessage: assistant,
                  toolCall: call,
                  args: call.arguments,
                  context: current,
                },
                toolContext.abortSignal,
              );
              if (result?.terminateAgent) toolStop = true;
              if (result?.block && result.terminate)
                toolControls.set(call.id, { terminate: true });
              if (result?.block)
                return { block: result.reason ?? 'Tool call blocked' };
            },
            async afterTool(call, result, _api, toolContext) {
              if (!assistant) return;
              const original: AgentToolResult = executedTools.get(call.id) ?? {
                content: [...(result.output ?? [])],
                details: result.details,
                ...(result.structuredOutput === undefined
                  ? {}
                  : { structuredContent: result.structuredOutput }),
                ...(result.usage === undefined ? {} : { usage: result.usage }),
              };
              let patch: Awaited<
                ReturnType<NonNullable<typeof config.afterToolCall>>
              >;
              try {
                patch = await config.afterToolCall?.(
                  {
                    assistantMessage: assistant,
                    toolCall: call,
                    args: toolArgs.get(call.id) ?? call.arguments,
                    result: original,
                    isError: result.isError ?? false,
                    context: current,
                  },
                  toolContext.abortSignal,
                );
              } catch (error) {
                return {
                  output: [
                    {
                      type: 'text',
                      text:
                        error instanceof Error ? error.message : String(error),
                    },
                  ],
                  isError: true,
                };
              }
              if (patch?.terminateAgent) toolStop = true;
              const output = patch?.content ?? result.output;
              // Take the product `structuredContent` from the executed tool's
              // own result: the harness only mirrors it for tools that declare
              // `structuredOutputSchema`, and product events must not depend on
              // that declaration.
              const structured =
                patch?.structuredContent ??
                (patch?.content ? undefined : original.structuredContent);
              const details = patch?.details ?? result.details;
              const usage = patch?.usage ?? result.usage;
              const isError = patch?.isError ?? result.isError;
              toolResults.set(call.id, {
                content: [...(output ?? [])],
                details: details as AgentToolResult['details'],
                ...(structured === undefined
                  ? {}
                  : { structuredContent: structured }),
                ...(usage === undefined ? {} : { usage }),
              });
              const terminate =
                patch?.terminate ??
                toolControls.get(call.id)?.terminate ??
                result.control?.terminate;
              // The harness checks the structuredOutput contract AFTER the
              // afterTool chain, so this return value must obey it too. Product
              // events already keep the value via `toolResults` above.
              const toolSchema = tools.find(
                (candidate) => candidate.name === call.name,
              )?.structuredOutputSchema;
              return nativeResult(
                {
                  ...(output === undefined ? {} : { output }),
                  ...(details === undefined ? {} : { details }),
                  ...(usage === undefined ? {} : { usage }),
                  ...(isError === undefined ? {} : { isError }),
                  ...(result.diagnostics === undefined
                    ? {}
                    : { diagnostics: result.diagnostics }),
                  ...(terminate ? { control: { terminate: true } } : {}),
                },
                structured !== undefined && toolSchema
                  ? { value: structured, schema: toolSchema }
                  : undefined,
              );
            },
          }),
        ],
      };

      function applyUpdate(update: {
        model?: Model<Api>;
        thinkingLevel?: ModelThinkingLevel;
      }) {
        config = {
          ...config,
          model: update.model ?? config.model,
          ...(update.thinkingLevel === undefined
            ? {}
            : {
                reasoning:
                  update.thinkingLevel === 'off'
                    ? undefined
                    : update.thinkingLevel,
              }),
        };
      }

      const transport: NativeStream = (_model, request, nativeOptions) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (failure) throw failure;
          const apiKey =
            (await config.getApiKey?.(config.model.provider)) || config.apiKey;
          const response = await streamFn(
            config.model,
            normalizeContext(request),
            {
              ...config,
              apiKey,
              signal: nativeOptions?.signal ?? signal,
            },
          );
          await forwardResponse(response, stream);
        })().catch((error) => {
          failure ??= error;
          stream.end(
            failedResponse(
              config.model,
              error,
              nativeOptions?.signal?.aborted === true,
            ),
          );
        });
        return stream;
      };

      async function forwardResponse(
        response: AssistantMessageEventStream,
        stream: AssistantMessageEventStream,
      ) {
        for await (const event of response) {
          if (event.type === 'done' || event.type === 'error') continue;
          if (!started) {
            started = true;
            await emit({
              type: 'message_start',
              message: { ...event.partial },
            });
          }
          if (event.type !== 'start') {
            await emit({
              type: 'message_update',
              message: { ...event.partial },
              assistantMessageEvent: event,
            });
          }
          stream.push(event);
        }
        stream.end(await response.result());
      }

      let aborting: Promise<void> | undefined;
      const abort = () => {
        aborting ??= conversation.abort(context);
        void aborting.catch(() => {});
      };
      this.routes.set(runId, route);
      this.transports.set(route, transport);
      try {
        harness.registry.install(extension);
        await conversation.reset(undefined, context);
        await conversation.configure(
          {
            model: { provider, modelId: runId },
            extensions: [extension],
            thinkingLevel: config.reasoning ?? 'off',
            compaction: { enabled: false },
          },
          context,
        );
        await emit({ type: 'agent_start' });
        await emit({ type: 'turn_start' });
        await appendInputs(prompts);
        signal?.throwIfAborted();
        // Native context anchors scheduling. beforeRequest supplies the actual
        // canonical product context, including history and before-LLM policy.
        const submission = await conversation.submit(
          {
            type: 'input',
            content: boundaryInput,
            whenBusy: 'reject',
            requestId: runId,
          },
          context,
        );
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        log.info('Native foreground submitted', {
          conversationId: conversation.id,
          submissionId: submission.id,
        });
        const outcome = await submission.wait(context);
        await conversation.waitForIdle(context);
        await eventTail;
        if (failure) throw failure;
        signal?.throwIfAborted();
        if (
          outcome.status !== 'done' &&
          assistant?.stopReason !== 'error' &&
          assistant?.stopReason !== 'aborted'
        ) {
          throw new Error(
            typeof outcome.detail === 'string'
              ? outcome.detail
              : `Native foreground did not answer: ${outcome.reason}`,
          );
        }
        await emit({ type: 'agent_end', messages: newMessages });
        return newMessages;
      } finally {
        signal?.removeEventListener('abort', abort);
        await aborting?.catch(() => {});
        harness.registry.uninstall(extension);
        this.transports.delete(route);
        this.routes.delete(runId);
      }
    };
  }
}

// Product tool values may carry private symbol metadata for UI and hooks.
// Persist only the same JSON representation the product journal can replay.
type NativeResultBase = Omit<ToolExecutionResult, 'details' | 'structuredOutput'> & {
  details?: unknown;
};

/**
 * The harness enforces "structuredOutput requires a declared schema" at
 * runtime (pi-durable harness/tool.ts), while its result type cannot express
 * that correlation, and excess-property checks do not fire on conditional
 * spreads. The claim argument does: `structuredOutput` reaches the harness
 * only through `{ value, schema }`, so `schema` (required, non-optional)
 * forces the caller to narrow the tool's declared schema — dropping the
 * narrowing from the condition is a compile error, not a runtime fault. The
 * schema itself is stripped: it belongs on the tool registration.
 */
function nativeResult(
  result: NativeResultBase,
  structuredOutput?: {
    // The product JsonValue (pi-ai) is structurally incompatible with the
    // harness JsonValue (chord: tuple arrays vs index signatures); the JSON
    // serialization below erases the difference, so cast once here instead of
    // at every call site.
    value: JsonValue;
    schema: NonNullable<ToolRegistration['structuredOutputSchema']>;
  },
): ToolExecutionResult {
  const next =
    structuredOutput === undefined
      ? result
      : {
          ...result,
          structuredOutput: structuredOutput.value as ToolExecutionResult['structuredOutput'],
        };
  return JSON.parse(JSON.stringify(next)) as ToolExecutionResult;
}

function failedResponse(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    content: [],
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
