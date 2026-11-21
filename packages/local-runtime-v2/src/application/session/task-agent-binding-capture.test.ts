import { describe, expect, it, vi } from 'vitest';

import type { ConversationTaskModelSelection } from '@mavis/conversation-contract';
import type {
  AgentExecutionProfile,
  LocalAgentService,
} from '../../service/agent/index.js';
import type { LocalConversationRuntimeConfig } from '../../service/model-system/index.js';
import type {
  FrozenAgentExecutionDefinition,
  SessionRecord,
} from '../../service/session-system/index.js';
import { createTaskAgentBindingCaptureCoordinator, type TaskAgentBindingCaptureCoordinator } from './task-agent-binding-capture.js';
import { bindTaskAgentBindingCapture } from './task-agent-ready-inventory.js';

const FLASH = 'minimax/MiniMax-M3.1-Flash';

// Managed MiniMax catalog: forced-on Flash (the incident model) plus one
// switchable M3 so a "different model" override is expressible.
const config: LocalConversationRuntimeConfig = {
  dataDir: '/data',
  defaultModel: FLASH,
  provider: {
    minimax: {
      models: {
        'MiniMax-M3.1-Flash': {
          limit: { context: 512_000, output: 128_000 },
          contextWindowOptions: [512_000, 1_000_000],
          thinking_config: { mode: 'forced_on' },
          thinking: {
            effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: 'default',
          },
          variants: {
            thinking: { thinking: { type: 'adaptive' } },
            'none-thinking': { thinking: { type: 'disabled' } },
          },
        },
        'MiniMax-M3': {
          limit: { context: 512_000, output: 128_000 },
          thinking_config: { mode: 'switchable', default_value: 'false' },
          thinking: { effortOptions: ['on', 'off'], defaultEffort: 'off' },
        },
      },
    },
  },
};

// The incident parent: same model, thinking variant, max effort, 1M context.
const parentModel = {
  providerId: 'minimax',
  modelId: 'MiniMax-M3.1-Flash',
  variant: 'thinking',
  thinking: { effort: 'max' },
  contextWindow: 1_000_000,
  parameterSnapshot: { context: 'selection', effort: 'selection' },
} satisfies FrozenAgentExecutionDefinition['model'];

const parentSession: SessionRecord = {
  sessionId: 'parent-1',
  agentName: 'mavis',
  workspaceDir: '/workspace',
  runtime: 'pi-agent',
  sessionType: 'root',
  sessionKind: 'conversation',
  archived: false,
  status: 'idle',
  createdAtMs: 1,
  updatedAtMs: 1,
};

const taskSession: SessionRecord = {
  ...parentSession,
  sessionId: 'task-1',
  sessionType: 'branch',
  sessionKind: 'task',
  parentSessionId: 'parent-1',
};

function capture(
  taskModelSelection?: ConversationTaskModelSelection,
  profileSelection?: AgentExecutionProfile['configSelection'],
) {
  const profile: AgentExecutionProfile = {
    requestRef: 'worker',
    resourceReadRef: 'worker',
    exactOwnerName: 'worker',
    canonicalViewName: 'worker',
    resolvedAgentName: 'worker',
    agentRole: 'worker',
    creationSource: 'builtin',
    surface: 'task-child',
    memoryReadAgentNames: [],
    agentSystemPrompt: 'prompt',
    corePrompt: 'prompt',
    surfacePrompt: '',
    capabilityCeiling: {
      personaEnabled: false,
      features: { mavis: false, delegation: false, webSearch: false },
    },
    ...(profileSelection ? { configSelection: profileSelection } : {}),
    provenance: { source: 'builtin', assetAgentName: 'worker', locale: 'en-US' },
  };
  const coordinator = createTaskAgentBindingCaptureCoordinator({
    agentService: { renderProfile: async () => profile } as unknown as LocalAgentService,
    config: () => config,
    inventory: {
      capture: async () => ({
        sources: {
          nativeTools: [],
          mcpEntries: [],
          threadGoalTools: [],
          cuRuntimeAvailable: false,
        },
        skills: [],
      }),
    },
  });
  return coordinator.capture({
    agentName: 'worker',
    session: taskSession,
    parent: parentSession,
    parentModel,
    ...(taskModelSelection ? { taskModelSelection } : {}),
  });
}

describe('task agent binding capture model group', () => {
  it('captures plugin delegates without looking up a nonexistent persisted agent', async () => {
    let coordinator!: TaskAgentBindingCaptureCoordinator;
    const lookupOwner = vi.fn(() => {
      throw new Error('Agent not found: fixture:probe');
    });
    const resolveSources = vi.fn(async () => ({
      nativeTools: [],
      mcpEntries: [],
      threadGoalTools: [],
      cuRuntimeAvailable: false,
    }));
    const listRuntimeSkills = vi.fn(async () => ({ skills: [] }));
    const release = vi.fn();
    bindTaskAgentBindingCapture(
      {
        agentService: { renderProfile: lookupOwner },
        product: {
          capabilities: { resolve: lookupOwner },
          toolSources: { resolve: resolveSources },
          turnRuntimeFacts: { snapshot: () => ({ cuModeActive: false }) },
          preparation: {
            configBuilder: {
              config: () => config,
              skills: { listRuntimeSkills },
            },
          },
        },
        turnCapabilities: { acquire: async () => ({
          release,
          capabilities: {
            revision: 'fixture', plugins: [], runtimeTools: [], runtimeToolBindings: [],
            skills: ['probe-skill', 'blocked-skill'].map((name) => ({
              pluginName: 'fixture', name: `fixture:${name}`, description: name,
              content: 'skill body', sourceKind: 'desktop-plugin',
            })),
          },
        }) },
        sessionSystem: {
          sessions: {
            records: {
              bindTaskAgentBindingCapture: (value: TaskAgentBindingCaptureCoordinator) => {
                coordinator = value;
              },
            },
          },
        },
        options: { runtimeOwnerKind: 'tui' },
      } as never,
      {
        plugin: { ready: async () => undefined },
        mcp: { ready: async () => undefined },
      } as never,
      {},
    );
    const captured = await coordinator.capture({
      agentName: 'worker',
      session: taskSession,
      parent: parentSession,
      parentModel,
      pluginAgent: {
        pluginName: 'fixture',
        name: 'fixture:probe',
        agentName: 'probe',
        description: 'Probe',
        systemPrompt: 'PLUGIN_PROMPT',
        pluginRoot: '/plugin',
        packageDigest: 'digest',
        sourceKind: 'local',
        skills: ['fixture:probe-skill'],
      },
    });
    expect(lookupOwner).not.toHaveBeenCalled();
    expect(resolveSources).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeAgentResources: true,
        skipAgentResolution: true,
        builtinCapabilities: expect.objectContaining({
          features: { mavis: false, delegation: false, webSearch: false },
        }),
      }),
    );
    expect(listRuntimeSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeAgentResources: true,
        skipAgentResolution: true,
      }),
    );
    expect(captured.agentDefinition.definition).toMatchObject({
      exactOwnerName: 'fixture:probe',
      systemPrompt: 'PLUGIN_PROMPT',
      capabilities: {
        skills: ['fixture:probe-skill'],
        extensionSkills: ['fixture:probe-skill'],
      },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps the parent group for an explicit same-model override without effort', async () => {
    const captured = await capture({ model: FLASH });
    expect(captured.effectiveModel).toBe(FLASH);
    expect(captured.effectiveModelVariant).toBe('thinking');
    expect(captured.effectiveModelThinking).toEqual({ effort: 'max' });
    expect(captured.effectiveModelContextWindow).toBe(1_000_000);
    expect(captured.agentDefinition.definition.model).toMatchObject({
      variant: 'thinking',
      thinking: { effort: 'max' },
      contextWindow: 1_000_000,
      parameterSnapshot: { context: 'selection', effort: 'selection' },
    });
  });

  // End-to-end counterpart of the task tool `model: "minimax/MiniMax-M3.1-Flash#thinking"`
  // call: local-task-input.test.ts proves the tool boundary splits the key into
  // this exact selection, which must capture without a catalog error and freeze
  // the variant with the parent's effort.
  it('captures the task tool #thinking override without a catalog error', async () => {
    const captured = await capture({ model: FLASH, variant: 'thinking' });
    expect(captured.effectiveModel).toBe(FLASH);
    expect(captured.effectiveModelVariant).toBe('thinking');
    expect(captured.effectiveModelThinking).toEqual({ effort: 'max' });
    expect(captured.effectiveModelContextWindow).toBe(1_000_000);
    expect(captured.agentDefinition.definition.model).toMatchObject({
      variant: 'thinking',
      thinking: { effort: 'max' },
    });
  });

  it('lets an explicit effort on the same model win over the inherited one', async () => {
    const captured = await capture({ model: FLASH, effort: 'high' });
    expect(captured.effectiveModelThinking).toEqual({ effort: 'high' });
    expect(captured.effectiveModelContextWindow).toBe(1_000_000);
  });

  it('resets effort and context when the override names a different model', async () => {
    const captured = await capture({ model: 'minimax/MiniMax-M3' });
    expect(captured.effectiveModel).toBe('minimax/MiniMax-M3');
    expect(captured.effectiveModelVariant).toBe('');
    // Switchable M3 defaults to thinking off: no thinking selection, catalog
    // context — none of the parent's max/1M group survives the model change.
    expect(captured.effectiveModelThinking).toBeUndefined();
    expect(captured.effectiveModelContextWindow).toBe(512_000);
  });

  it('inherits the parent group without any override', async () => {
    const captured = await capture();
    expect(captured.effectiveModel).toBe(FLASH);
    expect(captured.effectiveModelVariant).toBe('thinking');
    expect(captured.effectiveModelThinking).toEqual({ effort: 'max' });
    expect(captured.effectiveModelContextWindow).toBe(1_000_000);
  });

  it('keeps a target Agent model selection reset of the parent group', async () => {
    const captured = await capture(undefined, { model: 'minimax/MiniMax-M3' });
    expect(captured.effectiveModel).toBe('minimax/MiniMax-M3');
    expect(captured.effectiveModelThinking).toBeUndefined();
    expect(captured.effectiveModelContextWindow).toBe(512_000);
  });
});
