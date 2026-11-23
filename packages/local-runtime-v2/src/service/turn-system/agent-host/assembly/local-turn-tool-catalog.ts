import type { RuntimeTool, RuntimeToolSource } from '@mavis/agent-core/tools';
import { attachRuntimeToolMcpServer } from '@mavis/agent-core/tools';
import {
  createLocalBashToolDefinition,
  isSessionHistoryOnlyTool,
  resolveLocalBashShell,
} from '@mavis/agent-tools/desktop';
import {
  filterCanonicalNativeToolCeiling,
  createMcpInvokeTool,
  isMcpInvokeTool,
  createToolSearchTool,
  getSuppressedToolNamesForModelCapabilities,
  isCanonicalBuiltinTurn,
  modelInWhitelist,
  planMcpDisclosure,
  renderMcpToolSearchHintBlock,
  type McpDisclosureOptions,
  type McpToolEntry,
} from '@mavis/agent-tools';
import {
  AGENT_BUILTIN_MCP_TOOL_IDS,
  AGENT_BUILTIN_TOOL_IDS,
} from '@mavis/config';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { createCodemodeRuntimeTool } from '@mavis/codemode-host';
import type { NestedToolInvoker } from '@mavis/codemode-host';
import { isRunCodeEnabled } from '../codemode-gate.js';
import type { IModelCapabilities } from '@mavis/protocol';
import type { AgentHostTurnCapabilityView } from './turn-capability-lifecycle.js';
import type { HostCapabilityResolver } from './host-capability/contracts.js';
import { mergeAgentHostTurnCapabilities } from './local-turn-plugin-capabilities.js';
import type {
  LocalAgentCapabilityCeiling,
  LocalAgentConfigurationSelection,
  LocalAgentExecutionProfile,
} from '../preparation/contracts.js';

export function prepareBashTurnTools(admittedTools: readonly RuntimeTool[], background: boolean) {
  const hasNativeBash = admittedTools.some(
    (tool) => tool.def.name === 'bash' && (tool.source === undefined || tool.source === 'builtin'),
  );
  const bashCapabilities = {
    background,
    shell: hasNativeBash ? resolveLocalBashShell() : ('unavailable' as const),
  };
  return admittedTools.map((tool) => {
    if (tool.def.name !== 'bash' || (tool.source !== undefined && tool.source !== 'builtin'))
      return tool;
    const definition = createLocalBashToolDefinition(bashCapabilities);
    return {
      ...tool,
      def: { ...tool.def, schema: definition.schema, description: definition.description },
    };
  });
}

export interface LocalTurnRawToolSources {
  readonly nativeTools: readonly RuntimeTool[];
  readonly mcpEntries: readonly McpToolEntry[];
  readonly threadGoalTools: readonly RuntimeTool[];
  readonly cuRuntimeAvailable: boolean;
  /** External-tools-only mode: native sources are off, configured MCP only. */
  readonly externalToolsOnly?: boolean;
}

export interface LocalMcpToolSearchConfig {
  readonly enabled?: boolean;
  readonly modelWhitelist?: readonly string[];
  readonly thresholdPct?: number;
  readonly minDeferCount?: number;
  readonly topKDefault?: number;
  readonly topKMax?: number;
  readonly systemHint?: boolean;
  readonly maxSchemaTextLen?: number;
}

export interface LocalTurnToolCatalog {
  readonly tools: readonly RuntimeTool[];
  readonly userPromptPrefix: string;
}

export interface LocalTurnAgentProfileFacts {
  readonly excludeAgentResources?: boolean;
  readonly skipAgentResolution?: boolean;
  readonly expectedAgentInstanceId?: string;
  readonly capabilityCeiling: LocalAgentCapabilityCeiling;
  readonly canonicalRole?: string;
  readonly trustedBuiltin: boolean;
  readonly surface: LocalAgentExecutionProfile['surface'];
  /** Explicitly false disables all agent-scoped Memory operations for this Turn. */
  readonly agentMemoryEnabled?: boolean;
  /** Canonical-first Runtime Memory aliases, valid only when agent Memory is enabled. */
  readonly agentMemoryReadNames?: readonly string[];
  /** Raw Agent selectors; every value is intersected with this Turn's inventory. */
  readonly configSelection?: Pick<
    LocalAgentConfigurationSelection,
    'tools' | 'disallowedTools' | 'mcpServers' | 'skills' | 'extensionSkills'
  >;
}

export interface BuildLocalTurnToolCatalogInput {
  readonly sessionId: string;
  readonly sources: LocalTurnRawToolSources;
  readonly llmModel: {
    readonly provider: string;
    readonly id: string;
    readonly contextWindow: number;
  };
  readonly modelCapabilities?: IModelCapabilities;
  readonly agentProfile?: LocalTurnAgentProfileFacts;
  readonly config?: LocalMcpToolSearchConfig;
  /** Resolved `beta` of the owning conversation config; the `run_code` gate reads only `runCode`. */
  readonly beta?: { runCode?: boolean };
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly emitDiagnostic?: (type: string, payload: Readonly<Record<string, unknown>>) => void;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  readonly hostCapabilityRegistry?: HostCapabilityResolver;
  readonly effectivePluginSkills?: readonly {
    readonly pluginName: string;
    readonly name: string;
  }[];
  readonly userText?: string;
  /**
   * Exposure-side session tool policy: the exact built-in tool names the
   * Session's ACP policy keeps. `undefined` = legacy mode (no filtering).
   * Native built-ins, thread-goal tools, Builtin Matrix MCP tools and the
   * `run_code` gate are dropped unless named; the tools of configured MCP
   * servers and the disclosure tools that reach them stay.
   */
  readonly builtinToolAllowlist?: ReadonlySet<string>;
  /**
   * The MCP server names the Session's client supplied (session/new|load
   * `mcpServers`). Under an exact policy only those servers' tools stay
   * reachable — ambient project/data-dir servers and unprovenanced plugin
   * host tools are dropped. `undefined` = legacy mode (no server filtering).
   */
  readonly builtinToolServers?: ReadonlySet<string>;
  /**
   * LIVE policy check for composite execution paths that outlive the catalog
   * snapshot. The code runner and deferred gateway re-read it immediately
   * before executing each concrete target.
   */
  readonly liveSessionToolPolicy?: (tool: RuntimeTool) => boolean;
}

/** The already-gated inventory shared by Turn assembly and Task capture. */
export interface FilteredLocalTurnCapabilityInventory {
  readonly selector: LocalAgentCapabilitySelector;
  readonly nativeTools: readonly RuntimeTool[];
  readonly mcpEntries: readonly McpToolEntry[];
  readonly threadGoalTools: readonly RuntimeTool[];
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
}

/**
 * Applies only present-turn gates and Agent selectors to ready capability
 * inventories. It intentionally does not create disclosure tools, so a Task
 * capture can freeze the same allowed IDs without owning a second catalog.
 */
export function filterLocalTurnCapabilityInventory(input: {
  readonly sources: LocalTurnRawToolSources;
  readonly modelCapabilities?: IModelCapabilities;
  readonly agentProfile?: LocalTurnAgentProfileFacts;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  readonly hostCapabilityRegistry?: HostCapabilityResolver;
  readonly builtinToolAllowlist?: ReadonlySet<string>;
  readonly builtinToolServers?: ReadonlySet<string>;
}): FilteredLocalTurnCapabilityInventory {
  const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
  const profile = input.agentProfile;
  const selector = createLocalAgentCapabilitySelector(profile?.configSelection);
  const hasBrowserHostAlias = Boolean(
    input.hostCapabilityRegistry &&
    (profile?.surface ?? 'interactive') === 'interactive' &&
    input.desktopCapabilities?.hostBindings?.some(
      (binding) =>
        binding.hostCapability.id === 'browser.use' &&
        binding.hostCapability.version === 1 &&
        binding.allowedSurfaces.includes('interactive'),
    ),
  );
  const keep = (
    tool: RuntimeTool,
    source: RuntimeToolSource,
    options: {
      readonly mcp?: boolean;
      readonly serverName?: string;
      readonly selectorAlias?: string;
    } = {},
  ): boolean =>
    isReadyTurnToolAllowed({
      tool,
      source,
      options,
      excludedNames,
      cuRuntimeAvailable: input.sources.cuRuntimeAvailable,
      selector,
      profile,
    });
  const nativeTools = filterCanonicalNativeToolCeiling(
    input.sources.nativeTools.filter(
      (tool) =>
        sessionPolicyAllows(input.builtinToolAllowlist, tool.def.name) &&
        keep(
          tool,
          'builtin',
          hasBrowserHostAlias && tool.def.name === 'browser'
            ? { selectorAlias: 'mcp_browser' }
            : {},
        ),
    ),
    profile?.canonicalRole,
    profile?.trustedBuiltin === true,
  );
  // THEIR 0.7.2 canonical-MCP filter belongs to the deferred tool_search
  // family; until that lands, the kept entries pass through unfiltered.
  // A session tool policy gates the bundled Builtin Matrix tools by catalog
  // name, and every configured server by provenance: only the servers the
  // Session's client supplied stay — ambient project/data-dir servers are
  // dropped for restricted Sessions only (legacy keeps today's behavior).
  const mcpEntries = input.sources.mcpEntries.filter(
    ({ tool, source, serverName }) =>
      (source === 'builtin-matrix'
        ? sessionPolicyAllows(input.builtinToolAllowlist, tool.def.name)
        : sessionPolicyServerAllows(input.builtinToolServers, serverName)) &&
      keep(tool, source, { mcp: true, ...(serverName ? { serverName } : {}) }),
  );
  // Stamp the trusted server identity onto the kept entries' tools: the
  // model-visible name is a projection (normalized, shortened,
  // collision-disambiguated) and can never prove provenance by itself. The
  // stamps ride the tool OBJECT references into the inline list, the deferred
  // registry and the plugin-host merge, where dispatch reads them.
  for (const { tool, source, serverName } of mcpEntries) {
    if (source !== 'builtin-matrix' && serverName) attachRuntimeToolMcpServer(tool, serverName);
  }
  const threadGoalTools = resolveThreadGoalTools(
    profile,
    input.sources.threadGoalTools.filter(
      (tool) =>
        sessionPolicyAllows(input.builtinToolAllowlist, tool.def.name) && keep(tool, 'builtin'),
    ),
  );
  return {
    selector,
    nativeTools,
    mcpEntries,
    threadGoalTools,
    // Plugin runtime tools ride `desktopCapabilities`, not the native list:
    // in external-tools-only mode they are host-owned built-ins and stay off
    // here — the shared filter covers both the final catalog and the task
    // capture that freezes this inventory, so a captured ceiling can never
    // regain them on resume.
    ...(input.desktopCapabilities && input.sources.externalToolsOnly !== true
      ? {
          desktopCapabilities: filterDesktopCapabilities(
            input.desktopCapabilities,
            keep,
            profile?.configSelection?.mcpServers !== undefined,
            input.builtinToolServers,
          ),
        }
      : {}),
  };
}

/**
 * V2-owned final catalog policy used by the local AgentRuntime extension.
 * Product domains provide raw tools only; model gates, MCP disclosure and the
 * prompt hint are decided here from the frozen turn/model facts.
 */
export function buildLocalTurnToolCatalog(
  input: BuildLocalTurnToolCatalogInput,
): LocalTurnToolCatalog {
  const options = resolveLocalMcpDisclosureOptions(input.config, input.env);
  const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
  const inventory = filterLocalTurnCapabilityInventory(input);
  const { nativeTools, mcpEntries, threadGoalTools } = inventory;
  // Keep external tools directly callable without adding built-in lookup tools.
  const externalOnly = input.sources.externalToolsOnly === true;
  // Composite callers pass a LIVE reader; the snapshots above stay Turn-stable.
  const liveSessionToolPolicy = input.liveSessionToolPolicy;
  const model = input.llmModel;
  const plan = externalOnly
    ? { deferred: false as const, inlineTools: mcpEntries.map((entry) => entry.tool) }
    : planMcpDisclosure({ entries: mcpEntries, model, options });
  const tools = plan.deferred
    ? [
        ...nativeTools,
        ...plan.inlineTools,
        createToolSearchTool(plan.index, {
          topKDefault: options.topKDefault,
          topKMax: options.topKMax,
        }),
        createMcpInvokeTool(plan.deferredRegistry),
        ...threadGoalTools,
      ]
    : [
        ...nativeTools,
        ...plan.inlineTools,
        ...(input.hostCapabilityRegistry && !externalOnly
          ? [createMcpInvokeTool(new Map())]
          : []),
        ...threadGoalTools,
      ];

  if (excludedNames.size > 0) {
    input.emitDiagnostic?.('mcp.tools_suppressed_by_model_capability', {
      sessionId: input.sessionId,
      suppressedToolNames: [...excludedNames],
      supportImage: input.modelCapabilities?.support_image === true,
      supportVideo: input.modelCapabilities?.support_video === true,
    });
  }
  const desktopCapabilities = inventory.desktopCapabilities;
  const effectivePluginSkills = filterExtensionSkills(
    input.effectivePluginSkills ?? [],
    inventory.selector,
  );
  const merged = mergeAgentHostTurnCapabilities({
    tools,
    plan,
    model,
    options,
    effectivePluginSkills,
    ...(liveSessionToolPolicy ? { allowsDeferredTool: liveSessionToolPolicy } : {}),
    surface: input.agentProfile?.surface ?? 'interactive',
    ...(input.hostCapabilityRegistry && !externalOnly
      ? { hostCapabilityRegistry: input.hostCapabilityRegistry }
      : {}),
    ...(input.userText !== undefined ? { userText: input.userText } : {}),
    ...(desktopCapabilities ? { capabilities: desktopCapabilities } : {}),
  });
  input.emitDiagnostic?.('mcp.tools_deferred', {
    sessionId: input.sessionId,
    deferred: merged.plan.deferred,
    whitelisted: modelInWhitelist(model.provider, model.id, options.modelWhitelist),
    model: `${model.provider}/${model.id}`,
    ...(merged.plan.deferred ? merged.plan.stats : {}),
  });
  // OUR run_code gate (K2: beta.runCode or the MCODE_CODEMODE=1 dev hatch —
  // the SAME fact the prompt section renders from): the codemode runtime from
  // @mavis/codemode-host, appended LAST so nested calls resolve against every
  // other tool in this catalog. Worker sandbox per the accepted decision
  // (fresh worker+VM per run); scripts get only the injected tools —
  // no session/store/hidden surfaces, everything routes through ONE invoker.
  // A session tool policy gates it like any other built-in.
  const finalTools: RuntimeTool[] = [...merged.tools];
  if (
    !externalOnly &&
    sessionPolicyAllows(input.builtinToolAllowlist, 'run_code') &&
    isRunCodeEnabled(input.beta)
  ) {
    const callable = finalTools.filter((tool) => tool.def.name !== 'run_code');
    const runCode: RuntimeTool = {
      def: {
        name: 'run_code',
        description:
          'Run JavaScript that calls other tools. `code` is raw JavaScript run as an async function body in a QuickJS sandbox: top-level await and return work. No Node, file system, network, or timers; only the injected tools are callable via `tools.<name>({...})`. Only the script output reaches the model.',
        schema: Type.Object(
          {
            code: Type.String({
              description: 'Raw JavaScript source (not JSON, no code fence).',
            }),
          },
          { additionalProperties: false },
        ),
      },
      impl: {
        execute: async (
          ctx: import('@mavis/agent-core/tools').ToolExecutionContext,
          input: { code: string },
          signal?: AbortSignal,
        ) => {
          let nestedIndex = 0;
          const invoker: NestedToolInvoker = {
            invoke: async (name, args, options) => {
              nestedIndex += 1;
              const target = callable.find((tool) => tool.def.name === name);
              if (!target) throw new Error(`Tool "${name}" is not available to run_code`);
              // The catalog snapshot is per-Turn; the policy is not. Every
              // nested target re-reads the LIVE ceiling, so a narrowing that
              // landed after this Turn's assembly still binds the script.
              // The assembled gateway checks its resolved operation at dispatch.
              // All other children are checked here against the actual tool object.
              if (
                !isMcpInvokeTool(target) &&
                liveSessionToolPolicy &&
                !liveSessionToolPolicy(target)
              ) {
                throw new Error(
                  `Tool "${name}" is not part of this session's tool policy`,
                );
              }
              const nestedCtx = {
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                // Attribution only: the gateway owns authorization per child.
                toolCallId: `${ctx.toolCallId ?? ctx.turnId}/${nestedIndex}`,
              };
              // Nested-события (§3): ребёнок идёт через тот же STREAM_RESP
              // путь, что и прямые вызовы, с явным parentToolCallId; sink
              // отсутствует в голых тест-хостах — там живём без событий.
              const parentToolCallId = ctx.toolCallId ?? ctx.turnId;
              const startedMs = Date.now();
              ctx.nestedToolEvents?.start({
                toolCallId: nestedCtx.toolCallId,
                parentToolCallId,
                toolName: target.def.name,
                ...(args && typeof args === 'object' && !Array.isArray(args)
                  ? { args: args as Record<string, unknown> }
                  : {}),
              });
              let result;
              try {
                result = await target.impl.execute(nestedCtx, args as never, options?.signal);
              } catch (error) {
                ctx.nestedToolEvents?.end({
                  toolCallId: nestedCtx.toolCallId,
                  parentToolCallId,
                  toolName: target.def.name,
                  error:
                    options?.signal?.aborted
                      ? `cancelled: ${error instanceof Error ? error.message : String(error)}`
                      : error instanceof Error
                        ? error.message
                        : String(error),
                  durationMs: Date.now() - startedMs,
                });
                throw error;
              }
              ctx.nestedToolEvents?.end({
                toolCallId: nestedCtx.toolCallId,
                parentToolCallId,
                toolName: target.def.name,
                ...(result.details !== undefined
                  ? { result: result.details }
                  : {
                      result: {
                        text: (result.content ?? [])
                          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                          .map((block) => block.text)
                          .join('\n'),
                      },
                    }),
                ...(result.isError
                  ? {
                      error:
                        (result.content ?? [])
                          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                          .map((block) => block.text)
                          .join('\n') || 'child call failed',
                    }
                  : {}),
                durationMs: Date.now() - startedMs,
              });
              return {
                toolCallId: nestedCtx.toolCallId,
                result,
                isError: result.isError ?? false,
              };
            },
          };
          const entryDirectory = path.dirname(process.argv[1] ?? '');
          const codemode = createCodemodeRuntimeTool({
            resolveCallableTools: () =>
              callable.map((tool) => ({
                name: tool.def.name,
                description: tool.def.description,
                inputSchema: tool.def.schema,
              })),
            invoker,
            sandboxMode: 'worker',
            // esbuild's source plugin rewrites import.meta.url to the original
            // .ts path, so anchor the bundled worker at the running entry
            // (dist/mcoded.js | dist/cli.js -> dist/codemode-worker.js).
            workerUrl: pathToFileURL(path.join(entryDirectory, 'codemode-worker.js')),
            wasmPath: path.join(entryDirectory, 'quickjs.wasm'),
          });
          return await codemode.impl.execute(ctx, input as never, signal);
        },
      },
    };
    finalTools.push(runCode);
  }
  return {
    tools: finalTools,
    userPromptPrefix: renderUserPromptPrefix(
      merged.reminder,
      merged.plan.deferred,
      options.systemHint,
    ),
  };
}

export interface LocalAgentCapabilitySelector {
  allowsTool(name: string, hostAlias?: string): boolean;
  allowsMcpServer(serverName: string | undefined): boolean;
  allowsSkill(name: string): boolean;
  allowsExtensionSkill(pluginName: string, name: string): boolean;
}

function isReadyTurnToolAllowed(input: {
  readonly tool: RuntimeTool;
  readonly source: RuntimeToolSource;
  readonly options: {
    readonly mcp?: boolean;
    readonly serverName?: string;
    readonly selectorAlias?: string;
  };
  readonly excludedNames: ReadonlySet<string>;
  readonly cuRuntimeAvailable: boolean;
  readonly selector: LocalAgentCapabilitySelector;
  readonly profile: LocalTurnAgentProfileFacts | undefined;
}): boolean {
  if (input.excludedNames.has(input.tool.def.name)) return false;
  if (!isDesktopToolAvailable(input.tool, input.cuRuntimeAvailable)) return false;
  if (!input.selector.allowsTool(input.tool.def.name, isSessionHistoryOnlyTool(input.tool) ? 'read' : input.options.selectorAlias)) return false;
  if (!isMcpServerAllowed(input.selector, input.options)) return false;
  if (
    (DELEGATION_TOOL_NAMES.has(input.tool.def.name) ||
      (input.source !== 'builtin' && TASK_CONTROL_TOOL_NAMES.has(input.tool.def.name))) &&
    !isAuthoritativeMainProfile(input.profile)
  ) {
    return false;
  }
  if (!input.profile) return true;
  return isProfileToolAllowed(input.profile, input.tool, input.source);
}

function isDesktopToolAvailable(tool: RuntimeTool, cuRuntimeAvailable: boolean): boolean {
  return cuRuntimeAvailable || !tool.def.name.startsWith('desktop_');
}

function isMcpServerAllowed(
  selector: LocalAgentCapabilitySelector,
  options: { readonly mcp?: boolean; readonly serverName?: string },
): boolean {
  if (!options.mcp) return true;
  return selector.allowsMcpServer(options.serverName);
}

function isProfileToolAllowed(
  profile: LocalTurnAgentProfileFacts,
  tool: RuntimeTool,
  source: RuntimeToolSource,
): boolean {
  // A host-created facade grants only the current-session read capability.
  if (isSessionHistoryOnlyTool(tool)) {
    return profile.capabilityCeiling.tools === undefined || profile.capabilityCeiling.tools.includes('read');
  }
  if (profile.surface === 'task-child' && TASK_CHILD_BLOCKED_TOOL_NAMES.has(tool.def.name)) {
    return false;
  }
  if (isBuiltinSubagentTaskChild(profile) && tool.def.name === 'mavis') return false;
  return isProfileCapabilityEnabled(profile.capabilityCeiling, tool.def.name, source);
}

/**
 * Task operations are an owner-only authority. These facts are frozen from the
 * trusted Agent profile while assembling the Turn, rather than from a mutable
 * display name or a product capability flag.
 */
function isAuthoritativeMainProfile(profile: LocalTurnAgentProfileFacts | undefined): boolean {
  return (
    (profile?.surface === 'interactive' || profile?.surface === 'cli') &&
    profile.trustedBuiltin === true &&
    profile.canonicalRole === 'mavis'
  );
}

export function createLocalAgentCapabilitySelector(
  selection: LocalTurnAgentProfileFacts['configSelection'] | undefined,
): LocalAgentCapabilitySelector {
  const allowedTools = normalizeSelector(selection?.tools);
  const blockedTools = normalizeSelector(selection?.disallowedTools) ?? new Set<string>();
  const allowedMcpServers = normalizeSelector(selection?.mcpServers);
  const allowedSkills = normalizeSelector(selection?.skills);
  const allowedExtensionSkills = normalizeSelector(selection?.extensionSkills);
  return {
    allowsTool(name, hostAlias) {
      const names = [name, ...(hostAlias ? [hostAlias] : [])].map(normalizedSelectorName);
      return (
        !names.some((candidate) => blockedTools.has(candidate)) &&
        (!allowedTools || names.some((candidate) => allowedTools.has(candidate)))
      );
    },
    allowsMcpServer(serverName) {
      if (!allowedMcpServers) return true;
      return serverName ? allowedMcpServers.has(normalizedSelectorName(serverName)) : false;
    },
    allowsSkill(name) {
      return !allowedSkills || allowedSkills.has(normalizedSelectorName(name));
    },
    allowsExtensionSkill(pluginName, name) {
      if (!allowedExtensionSkills) return true;
      const normalizedName = normalizedSelectorName(name);
      return (
        allowedExtensionSkills.has(normalizedName) ||
        allowedExtensionSkills.has(`${normalizedSelectorName(pluginName)}:${normalizedName}`)
      );
    },
  };
}

function normalizeSelector(values: readonly string[] | undefined): ReadonlySet<string> | undefined {
  return values === undefined
    ? undefined
    : new Set(values.map(normalizedSelectorName).filter(Boolean));
}

function normalizedSelectorName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function filterDesktopCapabilities(
  capabilities: AgentHostTurnCapabilityView | undefined,
  keep: (
    tool: RuntimeTool,
    source: RuntimeToolSource,
    options?: { readonly mcp?: boolean; readonly serverName?: string },
  ) => boolean,
  requireMcpServerProvenance: boolean,
  sessionToolServers?: ReadonlySet<string>,
): AgentHostTurnCapabilityView | undefined {
  if (!capabilities) return undefined;
  // Under a session tool policy the plugin host surface needs provenance an
  // app/native binding cannot give: only bindings of the Session's own MCP
  // servers survive; unbound direct tools are dropped (fail closed).
  const policyAllowsBinding = (binding: AgentHostTurnCapabilityView['runtimeToolBindings'][number]): boolean =>
    sessionToolServers === undefined ||
    (binding.kind === 'mcp' && sessionToolServers.has(binding.source));
  const bindings = capabilities.runtimeToolBindings
    .filter(policyAllowsBinding)
    .filter((binding) =>
      keep(binding.tool, 'configured', {
        ...(binding.kind === 'mcp' ? { mcp: true, serverName: binding.source } : {}),
      }),
    );
  // Same provenance stamp as the ready MCP entries: a plugin-host MCP binding
  // carries its configured server identity on the tool object.
  for (const binding of bindings) {
    if (binding.kind === 'mcp') attachRuntimeToolMcpServer(binding.tool, binding.source);
  }
  const allowedBindingTools = new Set(bindings.map((binding) => binding.tool));
  const allBindingTools = new Set(capabilities.runtimeToolBindings.map((binding) => binding.tool));
  return {
    ...capabilities,
    runtimeToolBindings: bindings,
    runtimeTools: capabilities.runtimeTools.filter((tool) => {
      if (allBindingTools.has(tool)) return allowedBindingTools.has(tool);
      if (sessionToolServers !== undefined) return false;
      // Older/third-party capability providers can expose a direct RuntimeTool
      // without an owner binding. Keep that existing inventory under normal
      // gates. A declared MCP server selector is different: without server
      // provenance we cannot prove that an `mcp__*` tool belongs to an allowed
      // server, so fail closed only for that narrow ambiguous case.
      if (requireMcpServerProvenance && isMcpRuntimeTool(tool)) return false;
      return keep(tool, 'configured');
    }),
  };
}

function isMcpRuntimeTool(tool: RuntimeTool): boolean {
  return normalizedSelectorName(tool.def.name).startsWith('mcp__');
}

/** A session policy keeps only the names it holds; `undefined` = legacy mode keeps all. */
function sessionPolicyAllows(
  allowlist: ReadonlySet<string> | undefined,
  name: string,
): boolean {
  return allowlist === undefined || allowlist.has(name);
}

/**
 * A session policy keeps only the servers its client supplied — an entry
 * without a server name has no provenance and is dropped (fail closed).
 * `undefined` = legacy mode keeps every server.
 */
function sessionPolicyServerAllows(
  servers: ReadonlySet<string> | undefined,
  serverName: string | undefined,
): boolean {
  if (servers === undefined) return true;
  return serverName !== undefined && servers.has(serverName);
}

function filterExtensionSkills(
  skills: readonly { readonly pluginName: string; readonly name: string }[],
  selector: LocalAgentCapabilitySelector,
): readonly { readonly pluginName: string; readonly name: string }[] {
  return skills.filter((skill) => selector.allowsExtensionSkill(skill.pluginName, skill.name));
}

/**
 * SessionSend is a sub-command of the composite `mavis` Tool, so it cannot be
 * removed from the catalog on its own. A builtin SubAgent running as a task
 * child therefore loses the whole `mavis` Tool. The Agent profile resolver
 * already forces `features.mavis` off for this surface; repeating the rule on
 * the final catalog keeps it fail closed if raw sources or assembly order ever
 * change. Custom Agents and direct/root builtin Sessions are untouched.
 */
function isBuiltinSubagentTaskChild(profile: LocalTurnAgentProfileFacts): boolean {
  return (
    profile.surface === 'task-child' &&
    isCanonicalBuiltinTurn(profile.canonicalRole, profile.trustedBuiltin)
  );
}

/** Thread goal tools are withheld from task children and canonical builtin turns. */
function resolveThreadGoalTools(
  profile: LocalTurnAgentProfileFacts | undefined,
  threadGoalTools: readonly RuntimeTool[],
): readonly RuntimeTool[] {
  if (profile?.surface === 'task-child') return [];
  if (isCanonicalBuiltinTurn(profile?.canonicalRole, profile?.trustedBuiltin)) return [];
  return threadGoalTools;
}

/** Joins the plugin reminder with the MCP tool-search hint when both apply. */
function renderUserPromptPrefix(
  reminder: string | undefined,
  deferred: boolean,
  systemHint: boolean,
): string {
  return [reminder, deferred && systemHint ? renderMcpToolSearchHintBlock() : '']
    .filter(Boolean)
    .join('\n\n');
}

const TASK_CONTROL_TOOL_NAMES = new Set(['task_query', 'task_output', 'task_stop']);
const DELEGATION_TOOL_NAMES = new Set(['task', 'task_append']);
const TASK_CHILD_BLOCKED_TOOL_NAMES = new Set([...DELEGATION_TOOL_NAMES, 'todowrite', 'ask_user']);
const BUILTIN_NATIVE_TOOL_NAMES = new Set<string>(AGENT_BUILTIN_TOOL_IDS);
const BUILTIN_MCP_TOOL_NAMES = new Set<string>(AGENT_BUILTIN_MCP_TOOL_IDS);

function isProfileCapabilityEnabled(
  ceiling: LocalAgentCapabilityCeiling,
  toolName: string,
  source: RuntimeToolSource,
): boolean {
  if (!isFeatureEnabled(ceiling, toolName)) return false;
  if (source === 'builtin' && ceiling.tools && BUILTIN_NATIVE_TOOL_NAMES.has(toolName)) {
    return ceiling.tools.includes(toolName as (typeof ceiling.tools)[number]);
  }
  if (source === 'builtin-matrix' && ceiling.builtinTools && BUILTIN_MCP_TOOL_NAMES.has(toolName)) {
    return ceiling.builtinTools.includes(toolName as (typeof ceiling.builtinTools)[number]);
  }
  return true;
}

function isFeatureEnabled(ceiling: LocalAgentCapabilityCeiling, toolName: string): boolean {
  if (toolName === 'mavis') return ceiling.features.mavis;
  if (DELEGATION_TOOL_NAMES.has(toolName)) return ceiling.features.delegation;
  if (toolName === 'web_search') return ceiling.features.webSearch;
  return true;
}

export function resolveLocalMcpDisclosureOptions(
  raw: LocalMcpToolSearchConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): McpDisclosureOptions {
  return {
    enabled: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_ENABLED, raw?.enabled, true, parseBoolean),
    modelWhitelist: resolveModelWhitelist(env.MAVIS_MCP_TOOL_SEARCH_WHITELIST, raw),
    thresholdPct: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_THRESHOLD_PCT,
      raw?.thresholdPct,
      0.15,
      parseNumber,
    ),
    minDeferCount: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_MIN_DEFER_COUNT,
      raw?.minDeferCount,
      1,
      parseNumber,
    ),
    topKDefault: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_TOP_K_DEFAULT,
      raw?.topKDefault,
      5,
      parseNumber,
    ),
    topKMax: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_TOP_K_MAX, raw?.topKMax, 20, parseNumber),
    systemHint: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_SYSTEM_HINT,
      raw?.systemHint,
      true,
      parseBoolean,
    ),
    maxSchemaTextLen: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_MAX_SCHEMA_TEXT_LEN,
      raw?.maxSchemaTextLen,
      4_096,
      parseNumber,
    ),
  };
}

function resolveOption<T>(
  envValue: string | undefined,
  configured: T | undefined,
  fallback: T,
  parse: (value: string | undefined) => T | undefined,
): T {
  return parse(envValue) ?? configured ?? fallback;
}

function resolveModelWhitelist(
  envValue: string | undefined,
  raw: LocalMcpToolSearchConfig | undefined,
): string[] {
  const parsed = parseStringList(envValue);
  if (parsed) return parsed;
  return raw?.modelWhitelist ? [...raw.modelWhitelist] : [];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringList(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}
