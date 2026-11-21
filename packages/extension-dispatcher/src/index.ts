/**
 * `@mavis/extension-dispatcher` — the ONE extension funnel (W07 part B).
 *
 * Both public extension APIs dispatch through `ExtensionDispatcher`:
 * - pi `ExtensionAPI` compatibility facade: `createPiExtensionApi` (type-checked
 *   against the pinned coding-agent interface).
 * - product plugin-hook command SPI: `attachPluginHookBridge`.
 *
 * Band precedence product → plugin-hook → pi is documented in `dispatcher.ts`
 * and is the funnel's only ordering. Per-tool converters and the built-in tool
 * adapters (zone A) are NOT here; extension-registered tools live in the
 * dispatcher registry until the host's loadout/binding stage consumes them.
 */

export {
  DISPATCH_BANDS,
  ExtensionDispatcher,
  type DispatchBand,
  type DispatchError,
  type DispatchHandlerOptions,
  type DispatcherEventPayload,
  type DispatcherEventResult,
  type DispatcherOptions,
  type EmitOutcome,
  type RegisteredCommand,
  type RegisteredExtensionTool,
  type RegisteredFlag,
  type RegisteredShortcut,
} from './dispatcher.js';
export {
  PRODUCT_EVENT_NAMES,
  PI_EXTENSION_EVENT_NAMES,
  eventReduceKind,
  isDispatcherEventName,
  isPiExtensionEventName,
  type DispatcherEventName,
  type EventReduceKind,
  type PiExtensionEventName,
  type ProductEventName,
} from './events.js';
export {
  MissingHostCapabilityError,
  createPiExtensionApi,
  type CreatePiExtensionApiOptions,
  type PiExtensionApi,
  type PiExtensionHostCapabilities,
} from './pi-compat.js';
export {
  attachPluginHookBridge,
  type PluginHookBridgeOptions,
  type PluginHookBridgeOutcome,
  type PluginHookEventProjector,
} from './plugin-bridge.js';
export {
  createDispatcherToolHooks,
  type DispatcherToolHooks,
  type ToolEventProjection,
} from './agent-hooks.js';
