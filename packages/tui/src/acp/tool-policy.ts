/**
 * Per-session built-in tool policy on the ACP wire: parsing/validation of
 * `_meta["minimax-code/toolPolicy"]` (session/new, load, resume) and the
 * runtime binding behind it. Mirrors the permission-mode flow: an invalid or
 * unknown-name request is refused with -32602 BEFORE anything is created, a
 * runtime that cannot hold a policy is refused with -32603, and an absent key
 * keeps the Session's previous mode (restored from the durable store across a
 * process restart).
 *
 * The names of the MCP servers the SAME request supplied ride along: under an
 * exact policy only those servers' tools stay reachable for the Session, so
 * ambient project/data-dir servers cannot ride a restricted session.
 */

import * as acp from '@agentclientprotocol/sdk';
import {
  effectiveSessionToolNames,
  noBuiltinToolsFromEnv,
  parseSessionToolPolicyMeta,
  SESSION_TOOL_CATALOG,
  type SessionToolPolicyRequest,
} from '@mavis/config';

import type { TuiAcpRuntime } from './runtime.js';
import type { TuiSessionToolPolicyOrigin } from '../runtime/port.js';
import { TuiSessionToolPolicyUnsupportedError } from '../runtime/port.js';

export interface TuiAcpSessionToolsResult {
  readonly policy:
    | { readonly mode: 'legacy' }
    | { readonly mode: 'allow'; readonly allow: readonly string[]; readonly servers: readonly string[] };
  /** The stable catalog: every built-in tool a policy may name, with its source. */
  readonly catalog: readonly { readonly name: string; readonly source: string }[];
  /**
   * How `effective` was computed. `catalog`: the ceiling the Session is held
   * to — per-turn gates (model capabilities, agent ceilings, feature and
   * beta flags) can only remove names from it. `external-tools-only`: this
   * process exposes none of its built-ins, so the effective set is empty.
   */
  readonly basis: 'catalog' | 'external-tools-only';
  /** The catalog names this Session's policy keeps, in catalog order. */
  readonly effective: readonly string[];
}

/**
 * The tools listing of one Session: its policy, the stable catalog, and the
 * effective set. A session-level listing cannot see the per-turn model
 * context (the model may change mid-session), so `effective` reports the
 * policy ceiling — never more — and `basis` says which availability switch
 * already removed everything.
 */
export async function readTuiAcpSessionTools(
  runtime: TuiAcpRuntime,
  sessionId: string,
): Promise<TuiAcpSessionToolsResult> {
  const entry = await callSessionToolPolicy(runtime, (port) => {
    if (typeof port.getSessionToolPolicy !== 'function') {
      throw new TuiSessionToolPolicyUnsupportedError();
    }
    return port.getSessionToolPolicy(sessionId);
  });
  const externalToolsOnly = noBuiltinToolsFromEnv(process.env);
  const ceiling =
    entry === undefined
      ? SESSION_TOOL_CATALOG.map((tool) => tool.name)
      : effectiveSessionToolNames(entry.allow);
  return {
    policy:
      entry === undefined
        ? { mode: 'legacy' }
        : { mode: 'allow', allow: [...entry.allow], servers: [...entry.servers] },
    catalog: SESSION_TOOL_CATALOG,
    basis: externalToolsOnly ? 'external-tools-only' : 'catalog',
    effective: externalToolsOnly ? [] : ceiling,
  };
}

/** Parses and validates `_meta["minimax-code/toolPolicy"]`; throws -32602 on any defect. */
export function parseAcpToolPolicyMeta(meta: unknown): SessionToolPolicyRequest | undefined {
  const { request, error } = parseSessionToolPolicyMeta(meta);
  if (error) throw acpToolPolicyRequestError(error);
  return request;
}

function acpToolPolicyRequestError(
  error: NonNullable<ReturnType<typeof parseSessionToolPolicyMeta>['error']>,
): acp.RequestError {
  if (error.kind === 'unknown-names') {
    return acp.RequestError.invalidParams(
      { unknown: [...error.unknown], allowed: [...error.allowed] },
      `unknown tool names in "minimax-code/toolPolicy": ${error.unknown.join(', ')}`,
    );
  }
  if (error.kind === 'duplicate-names') {
    return acp.RequestError.invalidParams(
      { duplicates: [...error.duplicates] },
      `duplicate tool names in "minimax-code/toolPolicy": ${[...error.duplicates].join(', ')}`,
    );
  }
  return acp.RequestError.invalidParams(undefined, `invalid "minimax-code/toolPolicy": ${error.reason}`);
}

/**
 * Binds the Session's policy. An absent key (`undefined`) keeps the previous
 * mode and touches nothing — there is nothing to bind. A policy-bearing
 * request rides a single validated OBJECT (absent fields stay absent over
 * JSON; positional `undefined` would arrive as `null` and read as an explicit
 * empty list). A bind that would change the ceiling under a running Turn is
 * refused with -32602 (retry after the turn ends); `servers` names the MCP
 * servers the SAME request supplied, and the runtime narrows the Session's
 * reachable servers to them.
 */
export async function bindAcpSessionToolPolicy(
  runtime: TuiAcpRuntime,
  sessionId: string,
  request: SessionToolPolicyRequest | undefined,
  origin: TuiSessionToolPolicyOrigin,
  servers?: readonly string[],
): Promise<void> {
  if (request === undefined) return;
  const result = await callSessionToolPolicy(runtime, (port) => {
    if (typeof port.bindSessionToolPolicy !== 'function') {
      throw new TuiSessionToolPolicyUnsupportedError();
    }
    return port.bindSessionToolPolicy(
      sessionId,
      {
        allow: request.type === 'allow' ? request.allow : undefined,
        ...(servers ? { servers } : {}),
      },
      origin,
    );
  });
  if (result && !result.ok) {
    throw acp.RequestError.invalidParams(
      undefined,
      'a turn is active in this session; retry with its current tool policy or after the turn ends',
    );
  }
}

async function callSessionToolPolicy<T>(
  runtime: TuiAcpRuntime,
  call: (port: TuiAcpRuntime) => Promise<T>,
): Promise<T> {
  try {
    return await call(runtime);
  } catch (error) {
    if (error instanceof TuiSessionToolPolicyUnsupportedError) {
      throw acp.RequestError.internalError(undefined, error.message);
    }
    throw error;
  }
}
