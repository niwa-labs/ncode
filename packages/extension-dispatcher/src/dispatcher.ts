/**
 * ExtensionDispatcher — the ONE funnel both public extension APIs dispatch through
 * (port-plan §4 A5 merge row: «два public extension API обслуживаются одним dispatcher»,
 * plan :183; W07 D criterion «порядок двух extension API и conflict precedence», :775).
 *
 * Bands and precedence — documented, stable, and the only ordering the funnel knows:
 *
 *   1. `product`      — product-owned guards (permission modes, runaway-guard, policy).
 *                       May restrict; can never be loosened by an extension.
 *   2. `plugin-hook`  — the product plugin-hook command SPI (@mavis/plugin-hooks),
 *                       dispatched in the handler set's own declaration order by the runner.
 *   3. `pi`           — pi extensions, in registration order (pi's own dispatch rule,
 *                       pinned runner `snapshotEventHandlers` :1253).
 *
 * Within a band, handlers run in registration order. Deny precedence: on
 * result-bearing events a blocking/cancelling result short-circuits the chain
 * exactly like the pinned pi runner (`emitToolCall` :1253–1272 — the LAST
 * truthy result is remembered, a truthy `block` returns immediately), so a
 * lower band can never undo a higher band's block. Handler errors are
 * isolated: they are reported to the error listener and the chain continues
 * (pi `emitToolResult` :1212–1231); `user_bash` additionally rethrows after
 * reporting (pi :1290–1306).
 *
 * The dispatcher also owns the pi registration REGISTRIES (tools, commands,
 * flags, shortcuts, providers, MCP servers, virtual models, markdown
 * transformers, tool renderers). Both public APIs write the same registries —
 * there is deliberately no second copy of any registry.
 *
 * Product wiring status: the product runtime still dispatches through the
 * pre-switch mechanisms (agent-runtime `createExtensionApi`, local-runtime-v2
 * `plugin-hook-tool-lifecycle`); this package is gated and tested but NOT yet
 * switched.
 */

import { getCurrentSystemMessage } from '@earendil-works/pi-ai';

import { eventReduceKind, isDispatcherEventName, type DispatcherEventName } from './events.js';

/** Handler source bands in dispatch order. */
export const DISPATCH_BANDS = ['product', 'plugin-hook', 'pi'] as const;
export type DispatchBand = (typeof DISPATCH_BANDS)[number];

/** Shape-erased event payload: hosts pass the pinned pi event objects. */
export type DispatcherEventPayload = { readonly type: string } & Record<string, unknown>;

/** Shape-erased handler result: hosts interpret per event kind. */
export type DispatcherEventResult = Record<string, unknown> | undefined;

export interface DispatchHandlerOptions {
  readonly band: DispatchBand;
  /** Registration id, reported in errors (pi uses the extension path). */
  readonly owner: string;
}

interface DispatchEntry {
  readonly id: number;
  readonly event: DispatcherEventName;
  readonly band: DispatchBand;
  readonly owner: string;
  handler: (event: any, ctx: unknown) => Promise<unknown> | unknown;
}

export interface DispatchError {
  readonly event: DispatcherEventName;
  readonly band: DispatchBand;
  readonly owner: string;
  readonly message: string;
  readonly stack?: string;
}

export interface EmitOutcome {
  /** The reduced result, `undefined` when no handler produced one. */
  readonly result: DispatcherEventResult;
  /** Errors reported while dispatching (chain continued despite them). */
  readonly errors: readonly DispatchError[];
}

export interface RegisteredCommand {
  readonly name: string;
  readonly band: DispatchBand;
  readonly owner: string;
  readonly description?: string;
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
}

export interface RegisteredFlag {
  readonly name: string;
  readonly band: DispatchBand;
  readonly owner: string;
  readonly description?: string;
  readonly type: 'boolean' | 'string';
  readonly default?: boolean | string;
}

export interface RegisteredShortcut {
  readonly shortcut: string;
  readonly band: DispatchBand;
  readonly owner: string;
  readonly description?: string;
  readonly handler: (ctx: unknown) => Promise<void> | void;
}

/** A tool registered by an extension (pi `RegisteredTool` shape + band metadata). */
export interface RegisteredExtensionTool {
  readonly name: string;
  readonly band: DispatchBand;
  readonly owner: string;
  /** The pinned pi `ToolDefinition` (parameters/execute/exposure/loadout contract). */
  readonly definition: Record<string, unknown>;
}

export interface DispatcherOptions {
  /** Lists handler errors (pi `emitError`). Default: collect in outcome only. */
  onError?: (error: DispatchError) => void;
}

export class ExtensionDispatcher {
  private nextId = 0;
  private readonly entries: DispatchEntry[] = [];
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly flags = new Map<string, RegisteredFlag>();
  private readonly shortcuts: RegisteredShortcut[] = [];
  private readonly tools = new Map<string, RegisteredExtensionTool>();
  /** Registered providers/MCP servers/virtual models: stored opaquely per band+name. */
  private readonly providers = new Map<string, { band: DispatchBand; owner: string; config: unknown }>();
  private readonly mcpServers = new Map<string, { band: DispatchBand; owner: string; config: unknown }>();
  private readonly virtualModels = new Map<string, { band: DispatchBand; owner: string; definition: unknown }>();
  private readonly markdownTransformers: { band: DispatchBand; owner: string; transformer: unknown }[] = [];
  private readonly toolRenderers: { band: DispatchBand; owner: string; resolver: unknown }[] = [];
  private readonly messageRenderers = new Map<string, { band: DispatchBand; owner: string; renderer: unknown }[]>();
  private readonly entryRenderers = new Map<string, { band: DispatchBand; owner: string; renderer: unknown }[]>();
  /** Error listener; erasable-syntax mode forbids constructor parameter properties. */
  private readonly options: DispatcherOptions;

  constructor(options: DispatcherOptions = {}) {
    this.options = options;
  }

  /**
   * Register a handler. The last registration per (event, band, owner) wins for
   * dedup purposes is NOT applied — pi allows multiple handlers per extension
   * per event and preserves them all (pinned runner keeps handler arrays), so
   * does this dispatcher. Returns an unsubscribe function.
   */
  on(event: string, handler: (event: any, ctx: unknown) => Promise<unknown> | unknown, opts: DispatchHandlerOptions): () => void {
    if (!isDispatcherEventName(event)) {
      throw new Error(`Unknown extension event "${String(event)}"`);
    }
    const entry: DispatchEntry = { id: this.nextId++, event, band: opts.band, owner: opts.owner, handler };
    this.entries.push(entry);
    return () => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    };
  }

  /** Ordered snapshot: band precedence, then registration order within a band. */
  private handlersFor(event: DispatcherEventName): readonly DispatchEntry[] {
    return DISPATCH_BANDS.flatMap((band) =>
      this.entries.filter((entry) => entry.event === event && entry.band === band),
    );
  }

  private report(event: DispatcherEventName, entry: DispatchEntry, error: unknown, errors: DispatchError[]): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const dispatchError: DispatchError = { event, band: entry.band, owner: entry.owner, message, stack };
    errors.push(dispatchError);
    this.options.onError?.(dispatchError);
  }

  /** Notify-only fan-out: run every handler, isolate errors. */
  async emit(event: string, payload: unknown, ctx?: unknown): Promise<EmitOutcome> {
    if (!isDispatcherEventName(event)) {
      throw new Error(`Unknown extension event "${String(event)}"`);
    }
    return this.dispatch(event, payload, ctx);
  }

  /** Full reduce dispatch. Product/plugin-hook/pi code paths share this one funnel. */
  async dispatch(event: DispatcherEventName, payload: unknown, ctx?: unknown): Promise<EmitOutcome> {
    const kind = eventReduceKind(event);
    const errors: DispatchError[] = [];
    let result: DispatcherEventResult = undefined;

    switch (kind) {
      case 'notify': {
        for (const entry of this.handlersFor(event)) {
          try {
            await entry.handler(payload, ctx);
          } catch (error) {
            this.report(event, entry, error, errors);
          }
        }
        return { result: undefined, errors };
      }
      case 'first-result': {
        // pi `emitUserBash`/selection events: first defined result wins; user_bash
        // rethrows handler errors after reporting (runner :1290–1306).
        const rethrow = event === 'user_bash';
        for (const entry of this.handlersFor(event)) {
          let handlerResult: unknown;
          try {
            handlerResult = await entry.handler(payload, ctx);
          } catch (error) {
            this.report(event, entry, error, errors);
            if (rethrow) throw error;
            continue;
          }
          if (handlerResult !== undefined && handlerResult !== null) {
            result = handlerResult as DispatcherEventResult;
            return { result, errors };
          }
        }
        return { result: undefined, errors };
      }
      case 'unknown-request': {
        // before_provider_request: pi types the result `unknown` (:1450); the last
        // defined result wins so hosts can chain request transforms.
        for (const entry of this.handlersFor(event)) {
          try {
            const handlerResult = await entry.handler(payload, ctx);
            if (handlerResult !== undefined) result = handlerResult as DispatcherEventResult;
          } catch (error) {
            this.report(event, entry, error, errors);
          }
        }
        return { result, errors };
      }
      case 'tool-call': {
        return { result: (await this.dispatchToolCall(payload, ctx, errors)) ?? undefined, errors };
      }
      case 'tool-result-fold': {
        return { result: (await this.dispatchToolResult(payload, ctx, errors)) ?? undefined, errors };
      }
      case 'cancel-any': {
        for (const entry of this.handlersFor(event)) {
          let handlerResult: unknown;
          try {
            handlerResult = await entry.handler(payload, ctx);
          } catch (error) {
            this.report(event, entry, error, errors);
            continue;
          }
          if (isRecord(handlerResult) && handlerResult.cancel === true) {
            return { result: handlerResult as DispatcherEventResult, errors };
          }
        }
        return { result: undefined, errors };
      }
      case 'input-fold': {
        // pi `emitInput` (:1525–1566): every handler sees a fresh event carrying
        // the ACCUMULATED text/images; `handled` short-circuits (its result is
        // returned verbatim); `transform` accumulates `text`/`images`; errors
        // are isolated. Without a `handled` the outcome is the accumulated
        // transform, or `{action:'continue'}` when nothing changed.
        const source = isRecord(payload) ? payload : {};
        let currentText = source.text;
        let currentImages = source.images;
        for (const entry of this.handlersFor(event)) {
          const handlerEvent: Record<string, unknown> = { ...source, text: currentText, images: currentImages };
          let handlerResult: unknown;
          try {
            handlerResult = await entry.handler(handlerEvent, ctx);
          } catch (error) {
            this.report(event, entry, error, errors);
            continue;
          }
          if (!isRecord(handlerResult)) continue;
          if (handlerResult.action === 'handled') {
            return { result: handlerResult as DispatcherEventResult, errors };
          }
          if (handlerResult.action === 'transform') {
            currentText = handlerResult.text;
            currentImages = handlerResult.images ?? currentImages;
          }
        }
        result = (
          currentText !== source.text || currentImages !== source.images
            ? { action: 'transform', text: currentText, images: currentImages }
            : { action: 'continue' }
        ) as DispatcherEventResult;
        return { result, errors };
      }
      case 'context-fold': {
        // pi `emitContext` (:1305–1360): `context` handlers see the visible
        // (non-system) transcript and may return a new list or edit
        // `event.messages` IN PLACE (detected via the snapshot); the system
        // messages are restored afterwards (`restoreSystemMessages`). A
        // `context_with_system` handler sees the full transcript and its
        // returned list is used as returned; dropping the leading system
        // message is reported but honored (pin :1344–1352).
        const initial = extractMessages(payload);
        if (!initial) return { result: undefined, errors };
        let currentMessages: unknown[] = structuredClone(initial);
        for (const entry of this.handlersFor(event)) {
          const withSystem = event === 'context_with_system';
          const messages = withSystem
            ? currentMessages
            : currentMessages.filter((message) => !isRecord(message) || message.role !== 'system');
          const visibleSnapshot = withSystem ? undefined : messages.slice();
          const hadLeadingSystemMessage =
            withSystem && isFirstMessageSystem(currentMessages);
          const handlerEvent = { type: event, messages } as Record<string, unknown>;
          let handlerResult: unknown;
          try {
            handlerResult = await entry.handler(handlerEvent, ctx);
          } catch (error) {
            this.report(event, entry, error, errors);
            continue;
          }
          const returnedMessages =
            isRecord(handlerResult) && Array.isArray(handlerResult.messages)
              ? (handlerResult.messages as unknown[])
              : undefined;
          if (withSystem) {
            // context_with_system: the returned list is used as returned (pin
            // :1340); an absent return keeps the current transcript.
            if (returnedMessages) {
              currentMessages = returnedMessages;
              if (hadLeadingSystemMessage && !isFirstMessageSystem(currentMessages)) {
                this.report(event, entry, new Error(CONTEXT_LEADING_SYSTEM_LOST), errors);
              }
            }
            continue;
          }
          // context: a returned list or an in-place edit of event.messages
          // replaces the visible transcript (system messages restored).
          const returned =
            returnedMessages ??
            (sameMessages(messages, visibleSnapshot as unknown[]) ? undefined : messages);
          if (!returned) continue;
          currentMessages = restoreSystemMessages(
            currentMessages,
            visibleSnapshot as unknown[],
            returned,
          );
        }
        result = { messages: currentMessages } as unknown as DispatcherEventResult;
        return { result, errors };
      }
      case 'before-agent-start-fold': {
        // pi BeforeAgentStartEventResult: `message` + `systemPrompt`; later
        // handlers observe the earlier systemPrompt override (:1496–1501).
        const current = (isRecord(payload) ? { ...payload } : {}) as Record<string, unknown>;
        for (const entry of this.handlersFor(event)) {
          try {
            const handlerResult = await entry.handler(current, ctx);
            if (!isRecord(handlerResult)) continue;
            if (handlerResult.message !== undefined) current.message = handlerResult.message;
            if (handlerResult.systemPrompt !== undefined) current.systemPrompt = handlerResult.systemPrompt;
          } catch (error) {
            this.report(event, entry, error, errors);
          }
        }
        result = (current.message !== undefined || current.systemPrompt !== undefined
          ? { message: current.message, systemPrompt: current.systemPrompt }
          : undefined) as DispatcherEventResult;
        return { result, errors };
      }
      case 'message-end-fold': {
        // pi MessageEndEventResult: `message` replacement (role must be kept —
        // host-side validation; the dispatcher only folds the field).
        const current = (isRecord(payload) ? { ...payload } : {}) as Record<string, unknown>;
        for (const entry of this.handlersFor(event)) {
          try {
            const handlerResult = await entry.handler(current, ctx);
            if (isRecord(handlerResult) && handlerResult.message !== undefined) {
              current.message = handlerResult.message;
            }
          } catch (error) {
            this.report(event, entry, error, errors);
          }
        }
        result = (current.message !== undefined && current.message !== (payload as any)?.message
          ? { message: current.message }
          : undefined) as DispatcherEventResult;
        return { result, errors };
      }
      case 'boundary-fold': {
        // turn_end / agent_before_settle: BoundaryResult fields fold across
        // handlers, later field values win (pi folds `BoundaryResult` verbatim).
        const folded: Record<string, unknown> = {};
        let modified = false;
        for (const entry of this.handlersFor(event)) {
          try {
            const handlerResult = await entry.handler(payload, ctx);
            if (!isRecord(handlerResult)) continue;
            modified = true;
            for (const [key, value] of Object.entries(handlerResult)) {
              if (value !== undefined) folded[key] = value;
            }
          } catch (error) {
            this.report(event, entry, error, errors);
          }
        }
        return { result: (modified ? folded : undefined) as DispatcherEventResult, errors };
      }
    }
  }

  /**
   * pi `emitToolCall` semantics (:1253–1272): handlers run in band+registration
   * order; the LAST truthy result is remembered (falsy results — `undefined`,
   * `null`, `''`, `0`, `false` — never win, pin `if (handlerResult)`), and a
   * truthy `block` returns immediately, so lower bands cannot run after a
   * block. Argument modification is NOT folded here — pi mutates `event.input`
   * in place (ToolCallEventResult doc :1454–1463), which this preserves by
   * passing the payload object through unchanged.
   */
  private async dispatchToolCall(
    payload: unknown,
    ctx: unknown,
    errors: DispatchError[],
  ): Promise<DispatcherEventResult> {
    let result: DispatcherEventResult;
    for (const entry of this.handlersFor('tool_call')) {
      let handlerResult: unknown;
      try {
        handlerResult = await entry.handler(payload, ctx);
      } catch (error) {
        // pi emitToolCall does NOT catch handler errors (:1256–1266) — a throwing
        // tool_call handler surfaces to the tool pipeline. Preserve that.
        throw error;
      }
      if (handlerResult) {
        result = handlerResult as DispatcherEventResult;
        if (isRecord(handlerResult) && handlerResult.block) return result;
      }
    }
    return result;
  }

  /**
   * pi `emitToolResult` semantics (:1194–1242): EVERY handler observes the
   * accumulated event and may override content/details/structuredContent/
   * isError/usage; replacing `content` without returning `structuredContent`
   * drops the structured content (it may no longer match). Returns the merged
   * override, or `undefined` when nothing was modified.
   */
  private async dispatchToolResult(
    payload: unknown,
    ctx: unknown,
    errors: DispatchError[],
  ): Promise<DispatcherEventResult> {
    if (!isRecord(payload)) return undefined;
    const current: Record<string, unknown> = { ...payload };
    let modified = false;
    for (const entry of this.handlersFor('tool_result')) {
      let handlerResult: unknown;
      try {
        handlerResult = await entry.handler(current, ctx);
      } catch (error) {
        this.report('tool_result', entry, error, errors);
        continue;
      }
      if (!isRecord(handlerResult)) continue;
      if (handlerResult.content !== undefined) {
        current.content = handlerResult.content;
        // Structured content that is not replaced along with the content may no
        // longer match it (pinned runner :1209–1214).
        if (handlerResult.structuredContent === undefined) delete current.structuredContent;
        modified = true;
      }
      if (handlerResult.details !== undefined) {
        current.details = handlerResult.details;
        modified = true;
      }
      if (handlerResult.structuredContent !== undefined) {
        current.structuredContent = handlerResult.structuredContent;
        modified = true;
      }
      if (handlerResult.isError !== undefined) {
        current.isError = handlerResult.isError;
        modified = true;
      }
      if (handlerResult.usage !== undefined) {
        current.usage = handlerResult.usage;
        modified = true;
      }
    }
    if (!modified) return undefined;
    return {
      ...(current.content !== undefined ? { content: current.content } : {}),
      ...(current.details !== undefined ? { details: current.details } : {}),
      ...(current.structuredContent !== undefined ? { structuredContent: current.structuredContent } : {}),
      ...(current.isError !== undefined ? { isError: current.isError } : {}),
      ...(current.usage !== undefined ? { usage: current.usage } : {}),
    } as DispatcherEventResult;
  }

  // ─────────────────────────── Registries ───────────────────────────

  registerCommand(command: RegisteredCommand): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Command "${command.name}" is already registered (owner ${this.commands.get(command.name)?.owner})`);
    }
    this.commands.set(command.name, command);
  }

  getCommand(name: string): RegisteredCommand | undefined {
    return this.commands.get(name);
  }

  getCommands(): readonly RegisteredCommand[] {
    return [...this.commands.values()];
  }

  registerFlag(flag: RegisteredFlag): void {
    if (this.flags.has(flag.name)) {
      throw new Error(`Flag "${flag.name}" is already registered`);
    }
    this.flags.set(flag.name, flag);
  }

  getFlag(name: string): boolean | string | undefined {
    return this.flags.get(name)?.default;
  }

  getFlags(): readonly RegisteredFlag[] {
    return [...this.flags.values()];
  }

  registerShortcut(shortcut: RegisteredShortcut): void {
    this.shortcuts.push(shortcut);
  }

  getShortcuts(): readonly RegisteredShortcut[] {
    return [...this.shortcuts];
  }

  registerTool(tool: RegisteredExtensionTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): RegisteredExtensionTool | undefined {
    return this.tools.get(name);
  }

  getTools(): readonly RegisteredExtensionTool[] {
    return [...this.tools.values()];
  }

  registerProvider(name: string, band: DispatchBand, owner: string, config: unknown): void {
    this.providers.set(name, { band, owner, config });
  }

  unregisterProvider(name: string): void {
    this.providers.delete(name);
  }

  getProviderNames(): readonly string[] {
    return [...this.providers.keys()];
  }

  registerMcpServer(name: string, band: DispatchBand, owner: string, config: unknown): void {
    this.mcpServers.set(name, { band, owner, config });
  }

  unregisterMcpServer(name: string): void {
    this.mcpServers.delete(name);
  }

  getMcpServerNames(): readonly string[] {
    return [...this.mcpServers.keys()];
  }

  registerVirtualModel(key: string, band: DispatchBand, owner: string, definition: unknown): void {
    this.virtualModels.set(key, { band, owner, definition });
  }

  unregisterVirtualModel(key: string): void {
    this.virtualModels.delete(key);
  }

  getVirtualModelKeys(): readonly string[] {
    return [...this.virtualModels.keys()];
  }

  registerMarkdownTransformer(band: DispatchBand, owner: string, transformer: unknown): void {
    this.markdownTransformers.push({ band, owner, transformer });
  }

  getMarkdownTransformers(): readonly { band: DispatchBand; owner: string; transformer: unknown }[] {
    return [...this.markdownTransformers];
  }

  registerToolRenderer(band: DispatchBand, owner: string, resolver: unknown): void {
    this.toolRenderers.push({ band, owner, resolver });
  }

  getToolRenderers(): readonly { band: DispatchBand; owner: string; resolver: unknown }[] {
    return [...this.toolRenderers];
  }

  registerMessageRenderer(customType: string, band: DispatchBand, owner: string, renderer: unknown): void {
    let list = this.messageRenderers.get(customType);
    if (!list) {
      list = [];
      this.messageRenderers.set(customType, list);
    }
    list.push({ band, owner, renderer });
  }

  getMessageRenderers(): readonly { customType: string; band: DispatchBand; owner: string; renderer: unknown }[] {
    return [...this.messageRenderers.entries()].flatMap(([customType, list]) =>
      list.map((entry) => ({ customType, ...entry })),
    );
  }

  registerEntryRenderer(customType: string, band: DispatchBand, owner: string, renderer: unknown): void {
    let list = this.entryRenderers.get(customType);
    if (!list) {
      list = [];
      this.entryRenderers.set(customType, list);
    }
    list.push({ band, owner, renderer });
  }

  getEntryRenderers(): readonly { customType: string; band: DispatchBand; owner: string; renderer: unknown }[] {
    return [...this.entryRenderers.entries()].flatMap(([customType, list]) =>
      list.map((entry) => ({ customType, ...entry })),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractMessages(value: unknown): unknown[] | undefined {
  if (isRecord(value) && Array.isArray(value.messages)) return value.messages;
  return undefined;
}

/** Pin `sameMessages` (runner :280–282): per-element IDENTITY comparison. */
function sameMessages(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function isFirstMessageSystem(messages: unknown[]): boolean {
  return isRecord(messages[0]) && messages[0].role === 'system';
}

/**
 * Pin `restoreSystemMessages` (runner :292–302): an unchanged visible
 * conversation keeps every system message in place (cache-stable prefix); a
 * changed one gets the replayed prompt sections and tool declarations as ONE
 * leading system message, so pruning/windowing cannot drop them.
 */
function restoreSystemMessages(
  current: unknown[],
  visible: unknown[],
  returned: unknown[],
): unknown[] {
  if (sameMessages(returned, visible)) return current;
  const head = getCurrentSystemMessage(current as unknown as readonly { role: string }[]);
  return head ? [head, ...returned] : returned;
}

/** Pin :1349 — reported (not thrown) when a context_with_system handler drops it. */
const CONTEXT_LEADING_SYSTEM_LOST =
  'Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().';
