/** Log levels, ordered from most verbose to most severe (spec §5). */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * `off` is not an emit level; it only appears in `MCODE_LOG` filters to
 * disable a namespace entirely (spec §2).
 */
export type LogLevelOrOff = LogLevel | "off";

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export function isLogLevel(value: string): value is LogLevel {
  return value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error";
}

/** Parses a level token from `MCODE_LOG`; accepts `off` too; `null` when invalid. */
export function parseLevelOrOff(value: string): LogLevelOrOff | null {
  if (value === "off") return "off";
  return isLogLevel(value) ? value : null;
}
