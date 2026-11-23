/**
 * Per-session built-in tool policy registry (ACP
 * `_meta["minimax-code/toolPolicy"]`): one entry per bound Session, owned by
 * the runtime process (the mcoded daemon or an embedded off-mode host).
 *
 * DURABLE AND STORE-AUTHORITATIVE: unlike the permission-mode registry, the
 * ceiling SURVIVES the runtime process and the STORE decides. Every read and
 * every bind goes to the store first — an in-process cache would let a second
 * process (an embedded off-mode restart, another daemon) rebind from a stale
 * ceiling and widen what another process narrowed. Bind is transactional:
 * under the store's cross-process lock, re-read, intersect, WRITE, then
 * publish. Sidecar writes are atomic (tmp + rename).
 *
 * Fail-closed reads: a sidecar that EXISTS but cannot be read or parsed is a
 * broken RESTRICTION, not an absent one — it reads as the empty policy (no
 * built-in tool, no server) until an explicit bind re-states a ceiling. Only
 * a missing file is a never-bound legacy Session. A write failure throws:
 * the bind request fails loudly instead of publishing state nothing persists.
 *
 * Monotonic by construction: an explicit list intersects with the previous
 * allow set AND server set, a child (task subagent, side fork) inherits an
 * intersected copy, and no code path replaces a set with a wider one. A bind
 * that would CHANGE the ceiling under a running Turn is refused
 * (`turn_active`) — the permission-mode semantics — so a narrowing always
 * lands between Turns; re-binding the identical sets is a no-op even under a
 * running Turn (a cold resume re-sending its own policy must pass).
 *
 * Absent entry = legacy mode (every built-in tool); an entry with an empty
 * allow set = no built-in tool. The `servers` set names the MCP servers the
 * SESSION's client supplied: under an exact policy only those servers' tools
 * (and the named built-ins) stay reachable.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runtimeToolMcpServerOf, type RuntimeTool } from '@mavis/agent-core/tools';

import { loadSqlite3Constructor } from '../../infra/db/client.js';

export type SessionToolPolicyOrigin = 'new-explicit' | 'load-explicit' | 'inherited' | 'corrupt';

export interface SessionToolPolicyEntry {
  /** Exactly the built-in tool names this Session may use; empty = none. */
  readonly allow: ReadonlySet<string>;
  /** The MCP server names this Session's client supplied; other servers' tools are off. */
  readonly servers: ReadonlySet<string>;
  readonly origin: SessionToolPolicyOrigin;
}

/** JSON-safe view of {@link SessionToolPolicyEntry} (the daemon RPC wire shape). */
export interface SessionToolPolicyWireEntry {
  readonly allow: readonly string[];
  readonly servers: readonly string[];
  readonly origin: SessionToolPolicyOrigin;
}

/** What a store read established about one Session's sidecar. */
export type SessionToolPolicyRead =
  | { readonly status: 'absent' }
  | { readonly status: 'entry'; readonly entry: SessionToolPolicyWireEntry }
  /** The sidecar exists but cannot be read or parsed: fail closed, never legacy. */
  | { readonly status: 'unreadable'; readonly reason: string };

export type SessionToolPolicyBindResult =
  | { readonly ok: true; readonly entry: SessionToolPolicyEntry | undefined }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'turn_active';
        readonly current: SessionToolPolicyEntry | undefined;
      };
    };

export interface SessionToolPolicyRegistry {
  get(sessionId: string): SessionToolPolicyEntry | undefined;
  /**
   * Binds a Session's policy (session/new, load, resume) — transactionally:
   * under the store's lock, the store is re-read, the request intersects with
   * what it holds, the result is committed to the store, and only then is it
   * published. `undefined` allow keeps the previous ceiling (including across
   * a process restart). A bind that would change the ceiling while a Turn
   * runs in the Session is refused (`turn_active`); re-binding the identical
   * sets is always allowed.
   */
  bind(
    sessionId: string,
    allow: readonly string[] | undefined,
    origin: SessionToolPolicyOrigin,
    servers?: readonly string[],
  ): SessionToolPolicyBindResult;
  /** Child Sessions (task subagents, side forks) inherit the parent's policy. */
  inherit(childSessionId: string, parentSessionId: string): void;
  /** Idempotent; a missing entry is a no-op. */
  release(sessionId: string): void;
}

/** Durable sidecar backing: read/write/remove one Session's policy entry. */
export interface SessionToolPolicyStore {
  read(sessionId: string): SessionToolPolicyRead;
  write(sessionId: string, entry: SessionToolPolicyWireEntry): void;
  remove(sessionId: string): void;
  /** Serializes the registry's read-intersect-write section across processes. */
  withLock?<T>(sessionId: string, critical: () => T): T;
}

/** The fail-closed entry an unreadable sidecar reads as: nothing is granted. */
const EMPTY_POLICY: SessionToolPolicyEntry = {
  allow: new Set<string>(),
  servers: new Set<string>(),
  origin: 'corrupt',
};

export function createSessionToolPolicyRegistry(
  options: {
    readonly store?: SessionToolPolicyStore;
    /** Live Turn probe backing the `turn_active` refusal; absent (tests) never refuses. */
    readonly isTurnActive?: (sessionId: string) => boolean;
  } = {},
): SessionToolPolicyRegistry {
  const store = options.store;
  const inMemory = store ? undefined : new Map<string, SessionToolPolicyEntry>();
  const toEntry = (read: SessionToolPolicyRead): SessionToolPolicyEntry | undefined => {
    if (read.status === 'absent') return undefined;
    if (read.status === 'unreadable') return EMPTY_POLICY;
    return {
      allow: new Set(read.entry.allow),
      servers: new Set(read.entry.servers),
      origin: read.entry.origin,
    };
  };
  /** The store is the authority; nothing caches a decision across a read. */
  const load = (sessionId: string): SessionToolPolicyEntry | undefined => {
    return store ? toEntry(store.read(sessionId)) : inMemory?.get(sessionId);
  };
  const locked = <T>(sessionId: string, critical: () => T): T =>
    store?.withLock ? (store.withLock(sessionId, critical as () => unknown) as T) : critical();
  /** Commit to the store BEFORE publishing the entry to the caller. */
  const commit = (sessionId: string, entry: SessionToolPolicyEntry): SessionToolPolicyEntry => {
    store?.write(sessionId, {
      allow: [...entry.allow],
      servers: [...entry.servers],
      origin: entry.origin,
    });
    inMemory?.set(sessionId, entry);
    return entry;
  };
  const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
  };
  return {
    get: (sessionId) => load(sessionId),
    bind: (sessionId, allow, origin, servers) =>
      locked(sessionId, () => {
        const previous = load(sessionId);
        if (allow === undefined && servers === undefined) {
          return { ok: true as const, entry: previous };
        }
        let next: SessionToolPolicyEntry;
        if (allow === undefined) {
          // A load that names no policy but re-names its servers: the ceiling
          // stays; the server set only narrows.
          if (!previous) return { ok: true as const, entry: undefined };
          next = {
            ...previous,
            servers: new Set((servers ?? []).filter((name) => previous.servers.has(name))),
            origin,
          };
        } else if (!previous || previous.origin === 'corrupt') {
          // A first bind, or the recovery from a corrupt sidecar: the request
          // itself is trusted client input re-stating the ceiling.
          next = {
            allow: new Set(allow),
            servers: new Set(servers ?? []),
            origin,
          };
        } else {
          next = {
            allow: new Set(allow.filter((name) => previous.allow.has(name))),
            servers: new Set(
              (servers ?? [...previous.servers]).filter((name) => previous.servers.has(name)),
            ),
            origin,
          };
        }
        // Refuse a CHANGE under a running Turn; re-binding the identical
        // ceiling (a cold resume re-sending its own policy) always passes.
        if (
          previous !== undefined &&
          previous.origin !== 'corrupt' &&
          setsEqual(previous.allow, next.allow) && setsEqual(previous.servers, next.servers)
        ) {
          return { ok: true as const, entry: previous };
        }
        if (options.isTurnActive?.(sessionId) === true) {
          return { ok: false as const, error: { code: 'turn_active', current: previous } };
        }
        return { ok: true as const, entry: commit(sessionId, next) };
      }),
    inherit: (childSessionId, parentSessionId) =>
      locked(childSessionId, () => {
        const parent = load(parentSessionId);
        if (!parent) return;
        const current = load(childSessionId);
        const fresh = current === undefined || current.origin === 'corrupt';
        const next: SessionToolPolicyEntry = {
          allow: fresh
            ? new Set(parent.allow)
            : new Set([...parent.allow].filter((name) => current.allow.has(name))),
          servers: fresh
            ? new Set(parent.servers)
            : new Set([...parent.servers].filter((name) => current.servers.has(name))),
          origin: 'inherited',
        };
        commit(childSessionId, next);
      }),
    release: (sessionId) => {
      store?.remove(sessionId);
      inMemory?.delete(sessionId);
    },
  };
}

const STORE_SCHEMA_VERSION = 1;
/** A busy writer bounds the wait, then the mutation is refused. */
const LOCK_WAIT_MS = 250;

/**
 * File-backed store: one JSON sidecar per Session under
 * `<dataDir>/v2/session-tool-policy/`. Writes are atomic (tmp + rename) and
 * the read-intersect-write section is serialized across processes by an OS-backed SQLite writer lock.
 */
export function createSessionToolPolicyFileStore(dataDir: string): SessionToolPolicyStore {
  const directory = join(dataDir, 'v2', 'session-tool-policy');
  const fileOf = (sessionId: string) =>
    join(directory, `${Buffer.from(sessionId, 'utf8').toString('base64url')}.json`);
  return {
    read: (sessionId) => {
      let text: string;
      try {
        text = readFileSync(fileOf(sessionId), 'utf8');
      } catch (error) {
        const code = (error as { readonly code?: string }).code;
        if (code === 'ENOENT') return { status: 'absent' };
        return { status: 'unreadable', reason: `sidecar read failed: ${String(code ?? error)}` };
      }
      try {
        const raw = JSON.parse(text) as {
          schemaVersion?: unknown;
          allow?: unknown;
          servers?: unknown;
          origin?: unknown;
        };
        if (
          raw.schemaVersion !== STORE_SCHEMA_VERSION ||
          !Array.isArray(raw.allow) ||
          !Array.isArray(raw.servers) ||
          !isOrigin(raw.origin) ||
          raw.allow.some((name) => typeof name !== 'string') ||
          raw.servers.some((name) => typeof name !== 'string')
        ) {
          return { status: 'unreadable', reason: 'sidecar does not match the schema' };
        }
        return {
          status: 'entry',
          entry: { allow: raw.allow, servers: raw.servers, origin: raw.origin },
        };
      } catch (error) {
        return { status: 'unreadable', reason: `sidecar is not parsable: ${String(error)}` };
      }
    },
    write: (sessionId, entry) => {
      const file = fileOf(sessionId);
      mkdirSync(directory, { recursive: true });
      const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(
        temporary,
        `${JSON.stringify({
          schemaVersion: STORE_SCHEMA_VERSION,
          allow: [...entry.allow],
          servers: [...entry.servers],
          origin: entry.origin,
        })}\n`,
        'utf8',
      );
      renameSync(temporary, file);
    },
    remove: (sessionId) => {
      rmSync(fileOf(sessionId), { force: true });
    },
    withLock: (_sessionId, critical) => {
      mkdirSync(directory, { recursive: true });
      const Database = loadSqlite3Constructor();
      const connection = new Database(join(directory, 'writers.sqlite'), { timeout: LOCK_WAIT_MS });
      try {
        return connection.transaction(critical).immediate();
      } finally {
        connection.close();
      }
    },
  };
}

function isOrigin(value: unknown): value is SessionToolPolicyOrigin {
  return (
    value === 'new-explicit' ||
    value === 'load-explicit' ||
    value === 'inherited' ||
    value === 'corrupt'
  );
}

/**
 * Whether `policy` lets one concrete tool run — the one check direct
 * dispatch, the deferred gateway's resolved target and the `run_code` nested
 * invoker all share. An MCP-provenanced tool (a host-stamped server) passes
 * iff that server is one the Session's client supplied; every other tool
 * passes iff its name is in the allow set.
 */
export function sessionToolPolicyAllowsTool(
  policy: SessionToolPolicyEntry,
  tool: RuntimeTool,
): boolean {
  if (tool.source === 'builtin-matrix') return policy.allow.has(tool.def.name);
  const server = runtimeToolMcpServerOf(tool);
  if (server !== undefined) return policy.servers.has(server);
  return policy.allow.has(tool.def.name);
}
