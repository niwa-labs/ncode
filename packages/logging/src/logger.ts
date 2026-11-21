import { parseLogFilter, parseLogFormat, resolveNamespaceLevel, type LogFilter, type LogFormat } from './env.js';
import type { LogLevel, LogLevelOrOff } from './levels.js';
import { LOG_LEVEL_RANK } from './levels.js';
import { coerceLogFields, renderJsonLine, renderTextLine } from './render.js';

export type { LogLevel };
export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Новый логгер с подмешанными полями (корреляция: sessionId, turnId...). */
  child(bound: LogFields): Logger;
  /** Дешёвая проверка уровня — для guard-а дорогих вычислений (§7). */
  enabled(level: LogLevel): boolean;
}

interface LoggingConfig {
  readonly filter: LogFilter;
  readonly format: LogFormat;
}

function readConfigFromEnv(env: Record<string, string | undefined>): LoggingConfig {
  return { filter: parseLogFilter(env.MCODE_LOG), format: parseLogFormat(env.MCODE_LOG_FORMAT) };
}

// Env is read exactly once, at module initialization (spec §2); tests can
// reinitialize through `_initLoggingForTests`.
let config: LoggingConfig = readConfigFromEnv(process.env);
let loggerCache = new Map<string, Logger>();
const levelCache = new Map<string, LogLevelOrOff>();

function namespaceLevel(ns: string): LogLevelOrOff {
  const cached = levelCache.get(ns);
  if (cached !== undefined) return cached;
  const level = resolveNamespaceLevel(config.filter, ns);
  levelCache.set(ns, level);
  return level;
}

function levelEnabled(ns: string, level: LogLevel): boolean {
  const effective = namespaceLevel(ns);
  return effective !== 'off' && LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[effective];
}

/** Sink failures are silent: logging must never throw (spec §1). */
function writeStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // ignored by contract
  }
}

function createLoggerInstance(ns: string, bound: LogFields): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    try {
      if (!levelEnabled(ns, level)) return;
      // Per-call fields win over child-bound fields on key conflicts.
      const merged: LogFields = fields === undefined ? { ...bound } : { ...bound, ...fields };
      const ts = new Date();
      const coerced = coerceLogFields(merged);
      const ev = { ts, level, ns, msg };
      const line = config.format === 'json' ? renderJsonLine(ev, coerced) : renderTextLine(ev, coerced);
      writeStderr(line);
    } catch {
      // ignored by contract
    }
  };
  return {
    trace: (msg, fields) => emit('trace', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (next) => createLoggerInstance(ns, { ...bound, ...next }),
    enabled: (level) => {
      try {
        return levelEnabled(ns, level);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Creates (or returns the cached) logger for a namespace from the §4
 * registry — one module-level singleton per namespace (spec §1).
 */
export function createLogger(namespace: string): Logger {
  const cached = loggerCache.get(namespace);
  if (cached !== undefined) return cached;
  const created = createLoggerInstance(namespace, {});
  loggerCache.set(namespace, created);
  return created;
}

/**
 * Test seam: reinitializes module state as if the process had started with
 * the given environment, clearing the logger and level caches.
 */
export function _initLoggingForTests(env: Record<string, string | undefined>): void {
  config = readConfigFromEnv(env);
  levelCache.clear();
  loggerCache = new Map();
}
