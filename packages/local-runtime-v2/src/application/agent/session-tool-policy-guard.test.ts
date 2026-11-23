import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';

import {
  attachRuntimeToolMcpServer,
  type RuntimeTool,
} from '@mavis/agent-core/tools';
import {
  authorizeMcpInvokeReference,
  createMcpInvokeTool,
  resolveMcpInvokeTarget,
} from '@mavis/agent-tools';
import { SESSION_TOOL_CATALOG } from '@mavis/config';

import { createSessionToolPolicyGuard } from './session-tool-policy-guard.js';
import {
  createSessionToolPolicyFileStore,
  createSessionToolPolicyRegistry,
  sessionToolPolicyAllowsTool,
} from '../../service/permission/session-tool-policy.js';

function tool(name: string): RuntimeTool {
  return {
    def: { name, description: 'Synthetic test tool', schema: Type.Object({}) },
    impl: {
      execute: async () => ({
        tool_name: name,
        text: 'ok',
        content: [{ type: 'text' as const, text: 'ok' }],
      }),
    },
  };
}

function policyInput(
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
  tools: readonly RuntimeTool[] = [],
) {
  return {
    genuineUserQueryText: 'synthetic',
    ...(sessionId === undefined ? {} : { sessionId }),
    tools,
    toolContext: { toolCall: { id: 'call_1', name }, args } as never,
  };
}

describe('session tool policy dispatch guard', () => {
  it('passes everything for a legacy session and for allowed built-ins', async () => {
    const registry = createSessionToolPolicyRegistry();
    registry.bind('s1', ['read', 'images_understand'], 'new-explicit');
    const read = tool('read');
    const guard = createSessionToolPolicyGuard(registry);

    // No entry: the legacy all-tools mode never blocks.
    expect(
      await guard.beforeToolCall(policyInput('other', 'bash', {}, [tool('bash')])),
    ).toBeUndefined();
    // No session id (non-production bag): nothing to enforce against.
    expect(
      await guard.beforeToolCall(policyInput(undefined, 'bash', {}, [tool('bash')])),
    ).toBeUndefined();
    // Allowed names pass, catalog and extras alike.
    expect(await guard.beforeToolCall(policyInput('s1', 'read', {}, [read]))).toBeUndefined();
    expect(
      await guard.beforeToolCall(policyInput('s1', 'images_understand', {}, [tool('images_understand')])),
    ).toBeUndefined();
  });

  it('blocks unnamed tools and names that are not part of this turn', async () => {
    const registry = createSessionToolPolicyRegistry();
    registry.bind('s1', ['read'], 'new-explicit');
    const guard = createSessionToolPolicyGuard(registry);
    const tools = [tool('read'), tool('bash'), tool('run_code')];

    for (const name of ['bash', 'run_code']) {
      const decision = await guard.beforeToolCall(policyInput('s1', name, {}, tools));
      expect(decision).toMatchObject({
        block: true,
        reason: expect.stringContaining(`Tool "${name}" is not part of this session's tool policy`),
      });
    }
    // A name outside this Turn's assembled tools has no provenance at all:
    // stale or forged calls are blocked even when the name is allowed.
    const stale = await guard.beforeToolCall(policyInput('s1', 'read', {}, [tool('bash')]));
    expect(stale).toMatchObject({
      block: true,
      reason: expect.stringContaining("is not part of this turn's tools"),
    });
  });

  it('keeps a viewing-only session restricted after reopening its policy store', async () => {
    const data = mkdtempSync(join(tmpdir(), 'viewing-policy-'));
    try {
      const open = () => createSessionToolPolicyRegistry({ store: createSessionToolPolicyFileStore(data) });
      const sessionId = 'viewer';
      const registry = open();
      registry.bind(sessionId, ['read'], 'new-explicit');
      registry.bind('other', ['write'], 'new-explicit');
      const reopened = open();
      reopened.bind(sessionId, undefined, 'load-explicit');

      const guard = createSessionToolPolicyGuard(reopened);
      const tools = SESSION_TOOL_CATALOG.map(({ name }) => tool(name));
      const viewInput = policyInput(sessionId, 'read', { file_path: 'synthetic.mp4' }, tools);
      const read = tools.find((target) => target.def.name === 'read')!;
      expect(await guard.beforeToolCall(viewInput)).toBeUndefined();
      expect(
        await read.impl.execute({ sessionId, turnId: 'restored' }, { file_path: 'synthetic.mp4' } as never),
      ).toMatchObject({ tool_name: 'read' });
      for (const { name } of SESSION_TOOL_CATALOG) {
        if (name === 'read') continue;
        expect(await guard.beforeToolCall(policyInput(sessionId, name, {}, tools))).toMatchObject({
          block: true,
        });
      }
      expect(await guard.beforeToolCall(policyInput('other', 'write', {}, tools))).toBeUndefined();
      expect(await guard.beforeToolCall(policyInput('other', 'read', {}, tools))).toMatchObject({
        block: true,
      });
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('admits MCP tools by the tool-object stamp, never by projected name', async () => {
    const registry = createSessionToolPolicyRegistry();
    registry.bind('s1', [], 'new-explicit', ['my server', 'harness']);
    const guard = createSessionToolPolicyGuard(registry);
    // A server whose NAME needs projection ("my server" → mcp__my_server);
    // the stamp carries the raw configured identity.
    const projected = attachRuntimeToolMcpServer(tool('mcp__my_server__submit'), 'my server');
    const nested = attachRuntimeToolMcpServer(tool('mcp__harness__do__nested__name'), 'harness');
    const ambient = attachRuntimeToolMcpServer(tool('mcp__project__read_file'), 'project');
    const tools = [{ ...projected }, nested, ambient];

    expect(await guard.beforeToolCall(policyInput('s1', 'mcp__my_server__submit', {}, tools))).toBeUndefined();
    expect(await guard.beforeToolCall(policyInput('s1', 'mcp__harness__do__nested__name', {}, tools))).toBeUndefined();
    const denied = await guard.beforeToolCall(policyInput('s1', 'mcp__project__read_file', {}, tools));
    expect(denied).toMatchObject({ block: true });
    // An UNSTAMPED mcp__-shaped name (no trusted owner record) fails closed.
    const unstamped = await guard.beforeToolCall(
      policyInput('s1', 'mcp__harness__submit', {}, [tool('mcp__harness__submit')]),
    );
    expect(unstamped).toMatchObject({ block: true });
  });

  it('judges the deferred gateway RESOLVED target, not its wrapper', async () => {
    const registry = createSessionToolPolicyRegistry();
    registry.bind('s1', ['images_understand'], 'new-explicit', ['my server']);
    const guard = createSessionToolPolicyGuard(registry);

    // A real gateway over a deferred registry: a supplied server's tool (with
    // its raw-identity stamp) and a deferred catalog tool.
    const deferredTarget = attachRuntimeToolMcpServer(
      tool('mcp__my_server__submit'),
      'my server',
    );
    const catalog = tool('images_understand');
    const catalogTarget: RuntimeTool = {
      ...catalog,
      def: {
        ...catalog.def,
        prepareArguments(input) {
          if ((input as { asset?: string }).asset !== 'synthetic') {
            throw new Error('A synthetic asset is required');
          }
          return { asset: 'synthetic' };
        },
      },
    };
    const ambientTarget = attachRuntimeToolMcpServer(tool('mcp__project__read'), 'project');
    const gateway = createMcpInvokeTool(
      new Map([
        ['mcp__my_server__submit', deferredTarget],
        ['images_understand', catalogTarget],
        ['mcp__project__read', ambientTarget],
      ]),
    );
    const tools = [gateway, tool('tool_search')];

    // tool_search only reads the (already filtered) index.
    expect(await guard.beforeToolCall(policyInput('s1', 'tool_search', { query: 'read' }, tools))).toBeUndefined();
    // Allowed targets pass THROUGH the wrapper.
    expect(
      await guard.beforeToolCall(policyInput('s1', 'mcp_invoke', { tool_name: 'mcp__my_server__submit' }, tools)),
    ).toBeUndefined();
    expect(
      await guard.beforeToolCall(policyInput('s1', 'mcp_invoke', {
        tool_name: 'images_understand',
        arguments: { asset: 'synthetic' },
      }, tools)),
    ).toBeUndefined();
    expect(
      await guard.beforeToolCall(policyInput('s1', 'mcp_invoke', { tool_name: 'images_understand' }, tools)),
    ).toMatchObject({ block: true });
    // A denied deferred target is blocked through the wrapper — its handler
    // never runs.
    const ambient = await guard.beforeToolCall(
      policyInput('s1', 'mcp_invoke', { tool_name: 'mcp__project__read' }, tools),
    );
    expect(ambient).toMatchObject({
      block: true,
      reason: expect.stringContaining('mcp__project__read'),
    });
    const denied = await guard.beforeToolCall(
      policyInput('s1', 'mcp_invoke', { tool_name: 'bash' }, tools),
    );
    expect(denied).toMatchObject({ block: true });
    // An unknown deferred target is refused like the gateway itself would.
    const unknown = await guard.beforeToolCall(
      policyInput('s1', 'mcp_invoke', { tool_name: 'mcp__nowhere__gone' }, tools),
    );
    expect(unknown).toMatchObject({ block: true });
    // An unresolved reference has no trusted target.
    expect(
      await guard.beforeToolCall(policyInput('s1', 'mcp_invoke', { tool_ref: 'opaque' }, tools)),
    ).toMatchObject({ block: true });
  });

  it('checks the resolved reference even when it shares a name with an inline tool', async () => {
    const registry = createSessionToolPolicyRegistry();
    registry.bind('viewer', [], 'new-explicit', ['supplied']);
    const guard = createSessionToolPolicyGuard(registry);
    const allowed = attachRuntimeToolMcpServer(tool('view'), 'supplied');
    const denied = attachRuntimeToolMcpServer(tool('view'), 'other');
    const input = policyInput('viewer', 'view', {}, [allowed]);

    expect(await guard.beforeToolCall({ ...input, tool: denied })).toMatchObject({ block: true });
    expect(
      await guard.beforeToolCall({ ...input, tools: [], tool: allowed }),
    ).toBeUndefined();
  });

  it('checks actual gateway dispatch, including a reference admitted before narrowing', async () => {
    const registry = createSessionToolPolicyRegistry();
    registry.bind('viewer', ['read'], 'new-explicit');
    registry.bind('writer', ['write'], 'new-explicit');
    const calls: string[] = [];
    const trackedTool = (name: string) => {
      const target = tool(name);
      return {
        ...target,
        impl: {
          execute: async (...args: Parameters<RuntimeTool['impl']['execute']>) => {
            calls.push(name);
            return target.impl.execute(...args);
          },
        },
      };
    };
    const read = trackedTool('read');
    const write = trackedTool('write');
    const makeGateway = (sessionId: string) =>
      createMcpInvokeTool(
        new Map([['view', read], ['modify', write]]),
        new Map([['view-ref', { tool: read, pluginName: 'synthetic', inputSchema: read.def.schema }]]),
        (target) => sessionToolPolicyAllowsTool(registry.get(sessionId)!, target),
      );
    const viewer = makeGateway('viewer');
    const writer = makeGateway('writer');
    const viewerCtx = { sessionId: 'viewer', turnId: 'synthetic-turn' };
    const writerCtx = { ...viewerCtx, sessionId: 'writer' };
    const viaName = (tool_name: string) => ({ tool_name }) as never;

    expect((await viewer.impl.execute(viewerCtx, viaName('view'))).isError).toBeUndefined();
    expect((await viewer.impl.execute(viewerCtx, viaName('modify'))).isError).toBe(true);
    expect((await writer.impl.execute(writerCtx, viaName('view'))).isError).toBe(true);
    expect((await writer.impl.execute(writerCtx, viaName('modify'))).isError).toBeUndefined();

    const ref = { tool_ref: 'view-ref', arguments_json: '{}' };
    expect(resolveMcpInvokeTarget(viewer, ref)?.kind).toBe('resolved');
    expect(authorizeMcpInvokeReference(viewer, ref).kind).toBe('resolved');
    registry.bind('viewer', [], 'load-explicit');
    expect((await viewer.impl.execute(viewerCtx, ref as never)).isError).toBe(true);
    expect(calls).toEqual(['read', 'write']);
  });
});
