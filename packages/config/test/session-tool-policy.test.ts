import { describe, expect, it } from 'vitest';

import { AGENT_BUILTIN_MCP_TOOL_IDS, AGENT_BUILTIN_TOOL_IDS } from '../src/agent-capabilities.js';
import {
  ACP_SESSION_TOOL_POLICY_META_KEY,
  effectiveSessionToolNames,
  isSessionToolCatalogName,
  parseSessionToolPolicyMeta,
  SESSION_EXTRA_TOOL_IDS,
  SESSION_TOOL_CATALOG,
} from '../src/session-tool-policy.js';

describe('session tool policy meta', () => {
  it('the stable catalog covers the published built-ins and the extra harness tools', () => {
    expect(SESSION_TOOL_CATALOG.filter((e) => e.source === 'builtin').map((e) => e.name)).toEqual([
      ...AGENT_BUILTIN_TOOL_IDS,
      ...SESSION_EXTRA_TOOL_IDS,
    ]);
    expect(
      SESSION_TOOL_CATALOG.filter((e) => e.source === 'builtin-matrix').map((e) => e.name),
    ).toEqual([...AGENT_BUILTIN_MCP_TOOL_IDS, 'web_search']);
    expect(isSessionToolCatalogName('read')).toBe(true);
    // The extras are nameable harness tools, not silently-on stragglers.
    expect(isSessionToolCatalogName('run_code')).toBe(true);
    expect(isSessionToolCatalogName('task')).toBe(true);
    expect(isSessionToolCatalogName('web_search')).toBe(true);
    expect(isSessionToolCatalogName('desktop_screenshot')).toBe(false);
  });

  it('an absent key or non-object meta keeps the legacy mode', () => {
    expect(parseSessionToolPolicyMeta(undefined)).toEqual({ request: undefined, error: undefined });
    expect(parseSessionToolPolicyMeta({})).toEqual({ request: undefined, error: undefined });
    expect(parseSessionToolPolicyMeta(null)).toEqual({ request: undefined, error: undefined });
    expect(
      parseSessionToolPolicyMeta({ 'minimax-code/permissionMode': 'auto' }),
    ).toEqual({ request: undefined, error: undefined });
  });

  it('parses an allow list, preserves order, and accepts the empty list', () => {
    expect(parseSessionToolPolicyMeta({ [ACP_SESSION_TOOL_POLICY_META_KEY]: { allow: [] } })).toEqual(
      { request: { type: 'allow', allow: [] }, error: undefined },
    );
    const parsed = parseSessionToolPolicyMeta({
      [ACP_SESSION_TOOL_POLICY_META_KEY]: { allow: ['bash', 'read'] },
    });
    expect(parsed.request).toEqual({ type: 'allow', allow: ['bash', 'read'] });
    // Names are trimmed but never silently rewritten.
    const spaced = parseSessionToolPolicyMeta({
      [ACP_SESSION_TOOL_POLICY_META_KEY]: { allow: [' read '] },
    });
    expect(spaced.request).toEqual({ type: 'allow', allow: ['read'] });
  });

  it('refuses unknown names with the catalog (fail closed)', () => {
    const refused = parseSessionToolPolicyMeta({
      [ACP_SESSION_TOOL_POLICY_META_KEY]: { allow: ['read', 'definitely_not_a_tool'] },
    });
    expect(refused.request).toBeUndefined();
    expect(refused.error).toEqual({
      kind: 'unknown-names',
      unknown: ['definitely_not_a_tool'],
      allowed: SESSION_TOOL_CATALOG.map((entry) => entry.name),
    });
  });

  it('refuses duplicates, wrong shapes, and empty names', () => {
    const duplicates = parseSessionToolPolicyMeta({
      [ACP_SESSION_TOOL_POLICY_META_KEY]: { allow: ['read', 'read'] },
    });
    expect(duplicates.error).toEqual({ kind: 'duplicate-names', duplicates: ['read'] });

    for (const bad of [null, 7, 'read', { allow: 'read' }, { allow: [7] }, { allow: [''] }, {}]) {
      const refused = parseSessionToolPolicyMeta({ [ACP_SESSION_TOOL_POLICY_META_KEY]: bad });
      expect(refused.request).toBeUndefined();
      expect(refused.error?.kind).toBe('shape');
    }
  });

  it('the effective set is the catalog order intersected with the policy', () => {
    expect(effectiveSessionToolNames(['bash', 'not_in_catalog'])).toEqual(['bash']);
    expect(effectiveSessionToolNames([])).toEqual([]);
    const all = effectiveSessionToolNames(SESSION_TOOL_CATALOG.map((e) => e.name));
    expect(all).toEqual(SESSION_TOOL_CATALOG.map((e) => e.name));
    // The extras are selectable like any catalog name (catalog order wins).
    expect(effectiveSessionToolNames(['task', 'run_code'])).toEqual(['run_code', 'task']);
  });
});
