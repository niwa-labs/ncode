/**
 * Dispatcher event surface (W07 part B).
 *
 * The pi event names are exactly the `ExtensionAPI.on(event, …)` names of the
 * pinned coding-agent (`third_party/pi-mono/packages/coding-agent/src/core/extensions/types.ts`,
 * `ExtensionEvent` union, :1405–1442). The product events extend the dispatcher
 * for surfaces pi does not model (permission requests, subagent lifecycle);
 * the pi compatibility facade refuses to subscribe to them, so a pi extension
 * observes exactly the pi surface — compatibility is not widened silently.
 */

/** Events of the pinned pi `ExtensionAPI.on()` surface, in pi declaration order. */
export const PI_EXTENSION_EVENT_NAMES = [
  'project_trust',
  'resources_discover',
  'session_start',
  'session_info_changed',
  'session_before_switch',
  'session_before_fork',
  'session_before_compact',
  'session_before_tree',
  'session_compact',
  'session_compact_failed',
  'session_shutdown',
  'mcp_servers_change',
  'session_tree',
  'context',
  'context_with_system',
  'before_provider_request',
  'before_provider_headers',
  'after_provider_response',
  'provider_stream_event',
  'before_agent_start',
  'agent_start',
  'agent_end',
  'agent_before_settle',
  'agent_settled',
  'ui_prompt_start',
  'ui_prompt_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'model_select',
  'thinking_level_select',
  'tool_call',
  'tool_result',
  'user_bash',
  'input',
  'cache_warming_decision',
] as const;

export type PiExtensionEventName = (typeof PI_EXTENSION_EVENT_NAMES)[number];

/**
 * Product-only dispatcher events. `permission_request` carries the product
 * permission gate's question (plugin `PermissionRequest` hooks subscribe here);
 * `subagent_start` / `subagent_stop` project plugin `SubagentStart`/`SubagentStop`.
 */
export const PRODUCT_EVENT_NAMES = [
  'permission_request',
  'subagent_start',
  'subagent_stop',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

export type DispatcherEventName = PiExtensionEventName | ProductEventName;

export function isPiExtensionEventName(name: string): name is PiExtensionEventName {
  return (PI_EXTENSION_EVENT_NAMES as readonly string[]).includes(name);
}

export function isDispatcherEventName(name: string): name is DispatcherEventName {
  return isPiExtensionEventName(name) || (PRODUCT_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * Reduction semantics per event, mirroring the pinned pi runner
 * (`core/extensions/runner.ts`): `tool_call` = LAST truthy result is remembered
 * and a truthy `block` returns immediately (pinned `emitToolCall` :1253–1272);
 * `tool_result` = field-override fold across ALL handlers, content-replace
 * without explicit structuredContent drops the structured content
 * (:1194–1242); `input` = `transform` accumulates along the chain and
 * `handled` short-circuits (pinned `emitInput` :1525–1566); `context` /
 * `context_with_system` = handlers may return a new message list or edit
 * `event.messages` in place, system messages are restored for `context`
 * (pinned `emitContext` :1305–1360); cancellable `session_before_*` events
 * cancel when ANY handler cancels. Events without an entry are notify-only
 * fan-out with per-handler error isolation.
 */
export type EventReduceKind =
  | 'notify'
  | 'first-result'
  | 'tool-call'
  | 'tool-result-fold'
  | 'before-agent-start-fold'
  | 'message-end-fold'
  | 'cancel-any'
  | 'context-fold'
  | 'input-fold'
  | 'boundary-fold'
  | 'unknown-request';

const EVENT_REDUCE_KINDS: Readonly<Record<PiExtensionEventName, EventReduceKind>> = {
  project_trust: 'first-result',
  resources_discover: 'first-result',
  session_start: 'notify',
  session_info_changed: 'notify',
  session_before_switch: 'cancel-any',
  session_before_fork: 'cancel-any',
  session_before_compact: 'cancel-any',
  session_before_tree: 'cancel-any',
  session_compact: 'notify',
  session_compact_failed: 'notify',
  session_shutdown: 'notify',
  mcp_servers_change: 'notify',
  session_tree: 'notify',
  context: 'context-fold',
  context_with_system: 'context-fold',
  before_provider_request: 'unknown-request',
  before_provider_headers: 'notify',
  after_provider_response: 'notify',
  provider_stream_event: 'notify',
  before_agent_start: 'before-agent-start-fold',
  agent_start: 'notify',
  agent_end: 'notify',
  agent_before_settle: 'boundary-fold',
  agent_settled: 'notify',
  ui_prompt_start: 'notify',
  ui_prompt_end: 'notify',
  turn_start: 'notify',
  turn_end: 'boundary-fold',
  message_start: 'notify',
  message_update: 'notify',
  message_end: 'message-end-fold',
  tool_execution_start: 'notify',
  tool_execution_update: 'notify',
  tool_execution_end: 'notify',
  model_select: 'notify',
  thinking_level_select: 'notify',
  tool_call: 'tool-call',
  tool_result: 'tool-result-fold',
  user_bash: 'first-result',
  input: 'input-fold',
  cache_warming_decision: 'first-result',
};

const PRODUCT_REDUCE_KINDS: Readonly<Record<ProductEventName, EventReduceKind>> = {
  permission_request: 'first-result',
  subagent_start: 'notify',
  subagent_stop: 'notify',
};

export function eventReduceKind(name: DispatcherEventName): EventReduceKind {
  if (isPiExtensionEventName(name)) return EVENT_REDUCE_KINDS[name];
  return PRODUCT_REDUCE_KINDS[name];
}
