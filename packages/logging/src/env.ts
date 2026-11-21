import { parseLevelOrOff, type LogLevelOrOff } from './levels.js';

/**
 * Parsed `MCODE_LOG` (spec §2): a comma-separated list where an element
 * without `:` is the global default level and `name:level` is a prefix
 * override for a namespace (`cas:trace` matches `mcode:cas`, `mmu:off`
 * disables mmu).
 */
export interface LogFilter {
  defaultLevel: LogLevelOrOff;
  overrides: ReadonlyArray<{ name: string; level: LogLevelOrOff }>;
}

export const DEFAULT_LOG_FILTER: LogFilter = { defaultLevel: 'info', overrides: [] };

/**
 * Parses an `MCODE_LOG` value. `undefined`/empty means the default (`info`).
 * The name/level pair is split at the last `:`, so both `cas:trace` and the
 * fully-qualified `mcode:mmu:off` forms parse. Invalid tokens are ignored.
 */
export function parseLogFilter(spec: string | undefined): LogFilter {
  if (spec === undefined) return DEFAULT_LOG_FILTER;
  const overrides: Array<{ name: string; level: LogLevelOrOff }> = [];
  let defaultLevel: LogLevelOrOff | undefined;
  for (const rawToken of spec.split(',')) {
    const token = rawToken.trim();
    if (token.length === 0) continue;
    const lastColon = token.lastIndexOf(':');
    if (lastColon < 0) {
      const level = parseLevelOrOff(token);
      if (level !== null) defaultLevel = level;
      continue;
    }
    const name = token.slice(0, lastColon).trim();
    const level = parseLevelOrOff(token.slice(lastColon + 1).trim());
    if (name.length > 0 && level !== null) overrides.push({ name, level });
  }
  return { defaultLevel: defaultLevel ?? 'info', overrides };
}

/**
 * Prefix match from spec §2: the override name matches the namespace either
 * verbatim or after the `mcode:` prefix, and extends to sub-namespaces
 * (`cas` matches `mcode:cas` and `mcode:cas:sub`, but not `mcode:casino`).
 */
export function overrideMatchesNamespace(ns: string, name: string): boolean {
  return (
    ns === name ||
    ns.startsWith(`${name}:`) ||
    ns === `mcode:${name}` ||
    ns.startsWith(`mcode:${name}:`)
  );
}

/**
 * Effective level for a namespace: the global default, overridden by every
 * matching override in order (later entries win). Callers cache the result
 * per namespace so resolution is O(1) on the hot path (spec §2).
 */
export function resolveNamespaceLevel(filter: LogFilter, ns: string): LogLevelOrOff {
  let level = filter.defaultLevel;
  for (const override of filter.overrides) {
    if (overrideMatchesNamespace(ns, override.name)) level = override.level;
  }
  return level;
}

export type LogFormat = 'text' | 'json';

/** `MCODE_LOG_FORMAT` (spec §2): `json` or the `text` default; unknown → `text`. */
export function parseLogFormat(value: string | undefined): LogFormat {
  return value === 'json' ? 'json' : 'text';
}

/**
 * Secret field names that never reach any log or traffic file, always,
 * without exceptions (spec §8; traffic §3 keeps the rule even with
 * `MCODE_TRAFFIC_LOG_FULL=1`). Comparison is case-insensitive.
 */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'apikey',
  'authorization',
  'token',
  'cookie',
  'password',
]);

export function isSecretKey(key: string): boolean {
  return SECRET_FIELD_NAMES.has(key.toLowerCase());
}
