/**
 * pi ExtensionAPI compatibility facade over the ONE dispatcher (W07 part B).
 *
 * The facade object is type-checked against the pinned coding-agent's
 * `ExtensionAPI` interface (`third_party/pi-mono/packages/coding-agent`,
 * re-exported from the package root) — `createPiExtensionApi` declares
 * `satisfies PiExtensionApi`, so any drift between this facade and the pin is a
 * compile error, not a review finding. Types that the pin does not re-export
 * from its root (`Settings`, `CustomMessage`, `KeyId`) are derived structurally
 * from the interface itself, keeping the dependency on the public export map.
 *
 * Effect split: REGISTRATION methods (events, tools, commands, flags,
 * shortcuts, providers, MCP servers, virtual models, markdown transformers,
 * tool renderers) write the dispatcher registries — the single copy. SESSION
 * EFFECTS (sending messages, entries, settings, model/thinking, exec, active
 * tools, labels, session name) are delegated to the host capability bag; when a
 * capability is absent the method throws `MissingHostCapabilityError` instead of
 * silently no-oping, so an extension can never believe an effect happened.
 */

import type { Model, Provider } from '@earendil-works/pi-ai';
import type {
  EntryRenderer,
  ExtensionAPI,
  MessageRenderer,
  ProviderConfig,
  ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { TSchema as PiTSchema } from 'typebox';

import type { DispatchBand, ExtensionDispatcher } from './dispatcher.js';
import { isPiExtensionEventName } from './events.js';

/** The pin's interface, for `satisfies` and structural derivations. */
export type PiExtensionApi = ExtensionAPI;

type PiSettings = ReturnType<ExtensionAPI['getSettings']>;
type PiToolInfo = ReturnType<ExtensionAPI['getAllTools']>[number];
type PiSlashCommandInfo = ReturnType<ExtensionAPI['getCommands']>[number];
type PiRegisteredMcpServer = ReturnType<ExtensionAPI['getMcpServers']>[number];
type PiSendMessageArg = Parameters<ExtensionAPI['sendMessage']>[0];
type PiSendUserMessageContent = Parameters<ExtensionAPI['sendUserMessage']>[0];
type PiSendMessageOptions = Parameters<ExtensionAPI['sendMessage']>[1];
type PiSendUserMessageOptions = Parameters<ExtensionAPI['sendUserMessage']>[1];
type PiThinkingLevel = ReturnType<ExtensionAPI['getThinkingLevel']>;
type PiKeyId = Parameters<ExtensionAPI['registerShortcut']>[0];
type PiRegisterShortcutOptions = Parameters<ExtensionAPI['registerShortcut']>[1];
type PiRegisterCommandOptions = Parameters<ExtensionAPI['registerCommand']>[1];
type PiRegisterFlagOptions = Parameters<ExtensionAPI['registerFlag']>[1];
type PiVirtualModel = Parameters<ExtensionAPI['registerVirtualModel']>[0];
type PiExecOptions = Parameters<ExtensionAPI['exec']>[2];
type PiExecResult = Awaited<ReturnType<ExtensionAPI['exec']>>;

export class MissingHostCapabilityError extends Error {
  constructor(capability: string) {
    super(
      `ExtensionAPI method requires host capability "${capability}" that this host did not provide; ` +
        'the effect was NOT performed (no silent no-op).',
    );
    this.name = 'MissingHostCapabilityError';
  }
}

/**
 * Host-owned session effects the facade delegates to. Every field optional:
 * the host declares which effects it supports. Ownership stays with the product
 * session host (A3/A8); the dispatcher never hosts session state itself.
 */
export interface PiExtensionHostCapabilities {
  readonly sendMessage?: (message: PiSendMessageArg, options?: PiSendMessageOptions) => void;
  readonly sendUserMessage?: (content: PiSendUserMessageContent, options?: PiSendUserMessageOptions) => void;
  readonly appendEntry?: (customType: string, data?: unknown) => void;
  readonly setSessionName?: (name: string) => void;
  readonly getSessionName?: () => string | undefined;
  readonly setLabel?: (entryId: string, label: string | undefined) => void;
  readonly exec?: (command: string, args: string[], options?: PiExecOptions) => Promise<PiExecResult>;
  readonly getActiveTools?: () => string[];
  readonly getAllTools?: () => PiToolInfo[];
  /** Extension-registered MCP servers with their connection state (host-owned). */
  readonly getMcpServers?: () => PiRegisteredMcpServer[];
  readonly getSettings?: () => PiSettings;
  readonly setActiveTools?: (toolNames: string[]) => void;
  readonly getCommands?: () => PiSlashCommandInfo[];
  readonly setModel?: (model: Model<any>) => Promise<boolean>;
  readonly getThinkingLevel?: () => PiThinkingLevel;
  readonly setThinkingLevel?: (level: PiThinkingLevel) => void;
  /** Extension-to-extension bus (`pi.events`). Default: local error-isolated bus. */
  readonly events?: ExtensionAPI['events'];
  /** Resolved flags (CLI + settings). Default: the flag registry defaults. */
  readonly resolveFlag?: (name: string) => boolean | string | undefined;
}

export interface CreatePiExtensionApiOptions {
  readonly dispatcher: ExtensionDispatcher;
  /** Registration owner reported on registry entries and dispatch errors. */
  readonly owner: string;
  readonly host?: PiExtensionHostCapabilities;
}

function requireHost<K extends keyof PiExtensionHostCapabilities>(
  host: PiExtensionHostCapabilities | undefined,
  capability: K,
): NonNullable<PiExtensionHostCapabilities[K]> {
  const implementation = host?.[capability];
  if (!implementation) throw new MissingHostCapabilityError(String(capability));
  return implementation as NonNullable<PiExtensionHostCapabilities[K]>;
}

/** Local `pi.events` bus with the pinned core/event-bus.ts error isolation. */
function createLocalEventBus(): ExtensionAPI['events'] {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit: (channel, data) => {
      for (const handler of listeners.get(channel) ?? []) {
        try {
          handler(data);
        } catch (error) {
          console.error(`Event handler error (${channel}):`, error);
        }
      }
    },
    on: (channel, handler) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
  };
}

/**
 * Build a pi-compatible `ExtensionAPI` for ONE registration owner (one loaded
 * extension / one product subsystem). Everything registers into the single
 * dispatcher with band `'pi'`.
 */
export function createPiExtensionApi(options: CreatePiExtensionApiOptions): ExtensionAPI {
  const { dispatcher, owner, host } = options;
  const band: DispatchBand = 'pi';

  const api = {
    on(event: string, handler: (event: any, ctx: any) => any): () => void {
      // pi compatibility is not widened: the facade refuses product-only
      // dispatcher events (permission_request, subagent_*), so a pi extension
      // observes exactly the pinned surface.
      if (!isPiExtensionEventName(event)) {
        throw new Error(`Unknown extension event "${String(event)}"`);
      }
      return dispatcher.on(event, handler, { band, owner });
    },

    registerTool<TParams extends PiTSchema = PiTSchema, TDetails = unknown, TState = any>(
      tool: PiToolDefinition<TParams, TDetails, TState>,
    ): void {
      dispatcher.registerTool({
        name: tool.name,
        band,
        owner,
        definition: tool as unknown as Record<string, unknown>,
      });
    },

    registerCommand(name: string, commandOptions: PiRegisterCommandOptions): void {
      dispatcher.registerCommand({
        name,
        band,
        owner,
        description: commandOptions.description,
        handler: commandOptions.handler as (args: string, ctx: unknown) => Promise<void>,
      });
    },

    registerShortcut(shortcut: PiKeyId, shortcutOptions: PiRegisterShortcutOptions): void {
      dispatcher.registerShortcut({
        shortcut,
        band,
        owner,
        description: shortcutOptions.description,
        handler: shortcutOptions.handler as (ctx: unknown) => Promise<void> | void,
      });
    },

    registerFlag(name: string, flagOptions: PiRegisterFlagOptions): void {
      dispatcher.registerFlag({
        name,
        band,
        owner,
        description: flagOptions.description,
        type: flagOptions.type,
        ...(flagOptions.default !== undefined ? { default: flagOptions.default } : {}),
      });
    },

    getFlag(name: string): boolean | string | undefined {
      return host?.resolveFlag ? host.resolveFlag(name) : dispatcher.getFlag(name);
    },

    registerMarkdownTransformer(transformer: Parameters<ExtensionAPI['registerMarkdownTransformer']>[0]): void {
      dispatcher.registerMarkdownTransformer(band, owner, transformer);
    },

    registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void {
      // Erased registration: renderers are host-consumed display functions; the
      // dispatcher stores them by customType in band order.
      dispatcher.registerMessageRenderer(customType, band, owner, renderer);
    },

    registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void {
      dispatcher.registerEntryRenderer(customType, band, owner, renderer);
    },

    registerToolRenderer(resolver: Parameters<ExtensionAPI['registerToolRenderer']>[0]): void {
      dispatcher.registerToolRenderer(band, owner, resolver);
    },

    sendMessage(message: PiSendMessageArg, sendOptions?: PiSendMessageOptions): void {
      requireHost(host, 'sendMessage')(message, sendOptions);
    },

    sendUserMessage(content: PiSendUserMessageContent, sendOptions?: PiSendUserMessageOptions): void {
      requireHost(host, 'sendUserMessage')(content, sendOptions);
    },

    appendEntry(customType: string, data?: unknown): void {
      requireHost(host, 'appendEntry')(customType, data);
    },

    setSessionName(name: string): void {
      requireHost(host, 'setSessionName')(name);
    },

    getSessionName(): string | undefined {
      return requireHost(host, 'getSessionName')();
    },

    setLabel(entryId: string, label: string | undefined): void {
      requireHost(host, 'setLabel')(entryId, label);
    },

    exec(command: string, args: string[], execOptions?: PiExecOptions): Promise<PiExecResult> {
      return requireHost(host, 'exec')(command, args, execOptions);
    },

    getActiveTools(): string[] {
      return requireHost(host, 'getActiveTools')();
    },

    getAllTools(): PiToolInfo[] {
      return requireHost(host, 'getAllTools')();
    },

    getSettings(): PiSettings {
      return requireHost(host, 'getSettings')();
    },

    setActiveTools(toolNames: string[]): void {
      requireHost(host, 'setActiveTools')(toolNames);
    },

    getCommands(): PiSlashCommandInfo[] {
      return requireHost(host, 'getCommands')();
    },

    async setModel(model: Model<any>): Promise<boolean> {
      return requireHost(host, 'setModel')(model);
    },

    getThinkingLevel(): PiThinkingLevel {
      return requireHost(host, 'getThinkingLevel')();
    },

    setThinkingLevel(level: PiThinkingLevel): void {
      requireHost(host, 'setThinkingLevel')(level);
    },

    registerProvider(providerOrName: Provider | string, config?: ProviderConfig): void {
      const name = typeof providerOrName === 'string' ? providerOrName : (providerOrName as { id?: string }).id;
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('registerProvider: provider id is required');
      }
      dispatcher.registerProvider(name, band, owner, config ?? providerOrName);
    },

    unregisterProvider(name: string): void {
      dispatcher.unregisterProvider(name);
    },

    registerMcpServer(name: string, config: Parameters<ExtensionAPI['registerMcpServer']>[1]): void {
      dispatcher.registerMcpServer(name, band, owner, config);
    },

    unregisterMcpServer(name: string): void {
      dispatcher.unregisterMcpServer(name);
    },

    getMcpServers(): PiRegisteredMcpServer[] {
      // The dispatcher stores registration configs; the pin's RegisteredMcpServer
      // projection carries connection state that only the host owns.
      return requireHost(host, 'getMcpServers')();
    },

    registerVirtualModel(model: PiVirtualModel): void {
      const provider = (model as { provider?: string }).provider;
      const id = (model as { id?: string }).id;
      if (typeof provider !== 'string' || typeof id !== 'string') {
        throw new Error('registerVirtualModel: provider and id are required');
      }
      dispatcher.registerVirtualModel(`${provider}/${id}`, band, owner, model);
    },

    unregisterVirtualModel(provider: string, id: string): void {
      dispatcher.unregisterVirtualModel(`${provider}/${id}`);
    },

    events: host?.events ?? createLocalEventBus(),
  };
  // Type-level compatibility gate against the pin: if the pin's surface grows
  // or shrinks, this line fails to compile (W07 D: поштучный export inventory).
  return api satisfies ExtensionAPI as ExtensionAPI;
}

/** Re-export so hosts can type against the pin without a direct dependency. */
export type { ExtensionAPI };
