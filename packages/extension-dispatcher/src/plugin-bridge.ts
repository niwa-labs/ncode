/**
 * Plugin-hook bridge — the product plugin-hook command SPI (@mavis/plugin-hooks)
 * served through the SAME dispatcher as the pi compatibility facade (port-plan
 * §4 A5 merge row :183 «два public extension API обслуживаются одним dispatcher»;
 * §2.4.5 invariant :185 «удаление старого API-host не разрешает потерять plugin
 * hooks или их order»).
 *
 * Event mapping (one table, no second hub):
 *
 *   dispatcher (pi surface)      plugin-hook event      decision application
 *   ------------------------     -------------------    --------------------------------
 *   session_start            →   SessionStart           notify
 *   session_shutdown         →   SessionEnd             notify (runner owns its budget)
 *   input                    →   UserPromptSubmit       `decision: 'deny'` →
 *                                                           `{ action: 'handled' }`;
 *                                                       additionalContext → transform
 *   tool_call                →   PreToolUse             toolPermissionDecision deny →
 *                                                           `{ block: true, reason }`;
 *                                                           updatedInput → mutates
 *                                                           event.input in place (pi's
 *                                                           documented modification rule);
 *                                                           continue: false → stopRun flag
 *   permission_request       →   PermissionRequest      resolution folded into the
 *                                                           product-shaped result
 *   tool_result              →   PostToolUse            updatedResult → content fold
 *                                                           (model-visible only; audit
 *                                                           keeps the original — host duty)
 *   session_before_compact   →   PreCompact             cancel wins
 *   session_compact          →   PostCompact            notify
 *   agent_end                →   Stop                   continue: false → stopRun flag
 *   subagent_start           →   SubagentStart          notify
 *   subagent_stop            →   SubagentStop           notify
 *
 * Handler ORDER is the runner's own `compareHandlers` declaration order
 * (U24: plugin hooks keep their order — plan :775). Errors fail open exactly
 * like PluginHookRunner (diagnostics on the run result), never silently.
 */

import type {
  PluginHookCommandHandler,
  PluginHookDecision,
  PluginHookEventInput,
  PluginHookEventName,
  PluginHookRunResult,
} from '@mavis/plugin-hooks';

import type { DispatchError, ExtensionDispatcher } from './dispatcher.js';

/** Projects a dispatcher event payload into the runner's host-neutral input. */
export type PluginHookEventProjector = (
  event: string,
  payload: Record<string, unknown>,
) => Omit<PluginHookEventInput, 'event'>;

export interface PluginHookBridgeOptions {
  readonly dispatcher: ExtensionDispatcher;
  /** Shared runner instance (host owns lifecycle/observer/logger). */
  readonly run: (
    handlers: readonly PluginHookCommandHandler[],
    input: PluginHookEventInput,
    signal?: AbortSignal,
  ) => Promise<PluginHookRunResult>;
  readonly handlers: readonly PluginHookCommandHandler[];
  readonly project: PluginHookEventProjector;
}

export interface PluginHookBridgeOutcome {
  readonly run: PluginHookRunResult;
  /** Errors the dispatcher reported while projecting/running (fail-open diagnostics). */
  readonly errors: readonly DispatchError[];
}

interface MergedPluginOutcome {
  readonly decision: PluginHookDecision | undefined;
  readonly runResult: PluginHookRunResult;
}

async function runPluginEvent(
  options: PluginHookBridgeOptions,
  event: PluginHookEventName,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<MergedPluginOutcome> {
  const projected = options.project(event, payload);
  const input: PluginHookEventInput = { event, ...projected };
  const runResult = await options.run(options.handlers, input, signal);
  return { decision: runResult.decision, runResult };
}

/**
 * Attach the plugin-hook family to the dispatcher. Every mapping is registered
 * as band `'plugin-hook'` handlers, so the band precedence documented in
 * `dispatcher.ts` applies (product → plugin-hook → pi).
 */
export function attachPluginHookBridge(options: PluginHookBridgeOptions): {
  detach: () => void;
  outcomes: Map<string, PluginHookRunResult>;
} {
  const unsubscribes: (() => void)[] = [];
  const lastOutcomes = new Map<string, PluginHookRunResult>();

  const bridgeHandler =
    (event: PluginHookEventName, apply: (payload: Record<string, unknown>, decision: PluginHookDecision) => Record<string, unknown> | undefined) =>
    async (payload: unknown, ctx: unknown): Promise<Record<string, unknown> | undefined> => {
      const record = isRecord(payload) ? payload : {};
      const signal = isRecord(ctx) && ctx.signal instanceof AbortSignal ? ctx.signal : undefined;
      const { decision, runResult } = await runPluginEvent(options, event, record, signal);
      lastOutcomes.set(event, runResult);
      return decision ? apply(record, decision) : undefined;
    };

  const mappings: readonly (readonly [
    dispatcherEvent: string,
    pluginEvent: PluginHookEventName,
    apply: (payload: Record<string, unknown>, decision: PluginHookDecision) => Record<string, unknown> | undefined,
  ])[] = [
    ['session_start', 'SessionStart', () => undefined],
    ['session_shutdown', 'SessionEnd', () => undefined],
    [
      'input',
      'UserPromptSubmit',
      (payload, decision) => {
        // Deny: the prompt never reaches the agent (`action: 'handled'` — pi's
        // "extension consumed the input" outcome). additionalContext rides a
        // transform so the agent still sees the submitted text plus context.
        if (decision.decision === 'deny') return { action: 'handled' };
        if (decision.additionalContext) {
          return {
            action: 'transform',
            text: `${String(payload.text ?? '')}\n${decision.additionalContext}`,
          };
        }
        return undefined;
      },
    ],
    [
      'tool_call',
      'PreToolUse',
      (payload, decision) => {
        // pi's documented rule: argument modification happens by mutating
        // event.input in place (ToolCallEventResult doc, pin types :1454–1463).
        if (decision.updatedInput && isRecord(payload.input)) {
          Object.assign(payload.input, decision.updatedInput);
        }
        if (decision.toolPermissionDecision === 'deny') {
          return { block: true, reason: decision.reason ?? 'Blocked by PreToolUse hook' };
        }
        if (decision.continue === false) {
          return { block: true, reason: decision.reason ?? decision.stopReason ?? 'Stopped by PreToolUse hook', terminate: true };
        }
        return undefined;
      },
    ],
    ['permission_request', 'PermissionRequest', () => undefined],
    [
      'tool_result',
      'PostToolUse',
      (_payload, decision) => {
        // updatedResult replaces the MODEL-VISIBLE result only; audit/persistence
        // keeps the original (plugin-hooks contracts.ts :186–189).
        if (decision.updatedResult === undefined) return undefined;
        return { content: [{ type: 'text', text: stringifyUpdatedResult(decision.updatedResult) }] };
      },
    ],
    ['session_before_compact', 'PreCompact', (_p, d) => (d.decision === 'deny' ? { cancel: true } : undefined)],
    ['session_compact', 'PostCompact', () => undefined],
    ['agent_end', 'Stop', (_p, d) => (d.continue === false ? { stopRun: true } : undefined)],
    ['subagent_start', 'SubagentStart', () => undefined],
    ['subagent_stop', 'SubagentStop', () => undefined],
  ];

  for (const [dispatcherEvent, pluginEvent, apply] of mappings) {
    unsubscribes.push(
      options.dispatcher.on(dispatcherEvent, bridgeHandler(pluginEvent, apply), {
        band: 'plugin-hook',
        owner: 'plugin-hooks',
      }),
    );
  }

  return {
    detach: () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
    outcomes: lastOutcomes,
  };
}

function stringifyUpdatedResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
