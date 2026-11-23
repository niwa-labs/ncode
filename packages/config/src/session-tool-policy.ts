/**
 * Per-session built-in tool selection (ACP `session/new|load|resume`
 * `_meta["minimax-code/toolPolicy"]`).
 *
 * The STABLE surface a client may select from is the published id lists (the
 * native built-in tools and the standalone Builtin Matrix MCP tools) plus the
 * extra harness tools ({@link SESSION_EXTRA_TOOL_IDS}, the delegation family
 * and the feature/beta-gated surfaces). A name outside the catalog is refused
 * (fail closed): desktop/`computer_*` tools and every dynamically named tool
 * that is not a stable id can never be granted by a session policy.
 *
 * Absent `_meta` key keeps the Session's previous mode (no entry = the
 * legacy all-tools mode); `{ allow: [] }` means NO built-in tool. Enforcement
 * lives in the runtime (turn catalog + dispatch guard); this module only
 * names and validates.
 */

import { AGENT_BUILTIN_MCP_TOOL_IDS, AGENT_BUILTIN_TOOL_IDS } from './agent-capabilities.js';

/** `_meta` key carrying the per-session built-in tool selection. */
export const ACP_SESSION_TOOL_POLICY_META_KEY = 'minimax-code/toolPolicy';

/** Where a catalog tool comes from: the native registry or the bundled Matrix MCP server. */
export type SessionToolCatalogSource = 'builtin' | 'builtin-matrix';

/**
 * Stable harness tool ids that live outside the agent capability lists but
 * are real, nameable tools of the turn catalog: the delegation family, the
 * feature-owned surfaces and the beta-gated code runner. Listing them here
 * makes the catalog the FULL selection surface — a policy that names one of
 * them keeps it; availability is still a separate question (features, beta
 * flags and model gates can suppress a named tool for a given turn).
 */
export const SESSION_EXTRA_TOOL_IDS = [
  'ask_user',
  'code_review',
  'mavis',
  'memory',
  'request_feature_enable',
  'run_code',
  'skill',
  'task',
  'task_append',
] as const;

/** `web_search` is the feature-owned Builtin Matrix tool (MatrixWebSearchToolDef). */
const SESSION_EXTRA_MATRIX_TOOL_IDS = ['web_search'] as const;

export interface SessionToolCatalogEntry {
  /** Stable tool name: the name a session policy names and the model sees. */
  readonly name: string;
  readonly source: SessionToolCatalogSource;
}

/** The stable catalog: every built-in tool a session policy may name. */
export const SESSION_TOOL_CATALOG: readonly SessionToolCatalogEntry[] = [
  ...AGENT_BUILTIN_TOOL_IDS.map(
    (name): SessionToolCatalogEntry => ({ name, source: 'builtin' }),
  ),
  ...SESSION_EXTRA_TOOL_IDS.map(
    (name): SessionToolCatalogEntry => ({ name, source: 'builtin' }),
  ),
  ...AGENT_BUILTIN_MCP_TOOL_IDS.map(
    (name): SessionToolCatalogEntry => ({ name, source: 'builtin-matrix' }),
  ),
  ...SESSION_EXTRA_MATRIX_TOOL_IDS.map(
    (name): SessionToolCatalogEntry => ({ name, source: 'builtin-matrix' }),
  ),
];

const CATALOG_NAMES: ReadonlySet<string> = new Set(SESSION_TOOL_CATALOG.map((e) => e.name));

/** Whether `name` is part of the stable built-in tool catalog. */
export function isSessionToolCatalogName(name: string): boolean {
  return CATALOG_NAMES.has(name);
}

/** The effective set of a session: the catalog names its policy keeps. */
export function effectiveSessionToolNames(allow: readonly string[]): readonly string[] {
  return SESSION_TOOL_CATALOG.map((entry) => entry.name).filter((name) => allow.includes(name));
}

/** A parsed, validated session tool policy request. */
export type SessionToolPolicyRequest =
  | { readonly type: 'legacy' }
  | { readonly type: 'allow'; readonly allow: readonly string[] };

/** Why a `_meta` tool policy could not be accepted, with the offending values. */
export type SessionToolPolicyParseError =
  | { readonly kind: 'shape'; readonly reason: string }
  | {
      readonly kind: 'unknown-names';
      readonly unknown: readonly string[];
      readonly allowed: readonly string[];
    }
  | { readonly kind: 'duplicate-names'; readonly duplicates: readonly string[] };

/**
 * Parses `_meta["minimax-code/toolPolicy"]` from `session/new|load|resume`.
 *
 * - missing key / `undefined` → `{ type: 'legacy' }` (keep the previous mode);
 * - `{ allow: string[] }` → validated against the stable catalog;
 * - anything else → the shape error a caller turns into an explicit refusal.
 */
export function parseSessionToolPolicyMeta(meta: unknown): {
  readonly request: SessionToolPolicyRequest | undefined;
  readonly error: SessionToolPolicyParseError | undefined;
} {
  if (!isRecord(meta)) return { request: undefined, error: undefined };
  const raw = meta[ACP_SESSION_TOOL_POLICY_META_KEY];
  if (raw === undefined) return { request: undefined, error: undefined };
  if (!isRecord(raw)) {
    return {
      request: undefined,
      error: { kind: 'shape', reason: `${ACP_SESSION_TOOL_POLICY_META_KEY} must be an object` },
    };
  }
  const allow = raw.allow;
  if (allow === undefined) {
    return {
      request: undefined,
      error: {
        kind: 'shape',
        reason: `${ACP_SESSION_TOOL_POLICY_META_KEY}.allow must be an array of tool names`,
      },
    };
  }
  if (!Array.isArray(allow) || allow.some((name) => typeof name !== 'string')) {
    return {
      request: undefined,
      error: {
        kind: 'shape',
        reason: `${ACP_SESSION_TOOL_POLICY_META_KEY}.allow must be an array of tool names`,
      },
    };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of allow) {
    const name = value.trim();
    if (!name) {
      return {
        request: undefined,
        error: {
          kind: 'shape',
          reason: `${ACP_SESSION_TOOL_POLICY_META_KEY}.allow holds an empty tool name`,
        },
      };
    }
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
    names.push(name);
  }
  if (duplicates.size > 0) {
    return {
      request: undefined,
      error: { kind: 'duplicate-names', duplicates: [...duplicates] },
    };
  }
  const unknown = names.filter((name) => !CATALOG_NAMES.has(name));
  if (unknown.length > 0) {
    return {
      request: undefined,
      error: {
        kind: 'unknown-names',
        unknown,
        allowed: SESSION_TOOL_CATALOG.map((entry) => entry.name),
      },
    };
  }
  return { request: { type: 'allow', allow: names }, error: undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
