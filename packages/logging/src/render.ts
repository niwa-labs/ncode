import { createHash } from 'node:crypto';
import { isSecretKey } from './env.js';
import type { LogLevel } from './levels.js';

/** JSON preview budget for object/array field values (spec §1). */
export const PREVIEW_MAX_BYTES = 512;
/** Long string (message body) truncation point in normal logs (spec §8). */
export const STRING_TRUNCATE_CHARS = 200;
/** `Error.stack` budget (spec §1: stack ≤ 2KB). */
export const STACK_MAX_CHARS = 2048;
/** base64/blob candidates must be longer than this to be redacted (spec §8). */
export const BASE64_MIN_LENGTH = 256;

const ELLIPSIS = '…';

/**
 * A string "looks like base64/blob" when it is longer than the spec minimum
 * and consists solely of base64 alphabet characters (standard and URL-safe,
 * optional padding, whitespace allowed inside — MIME-wrapped blobs).
 */
export function isBase64Candidate(s: string): boolean {
  if (s.length <= BASE64_MIN_LENGTH) return false;
  const compact = s.replace(/\s+/g, '');
  return compact.length > BASE64_MIN_LENGTH && /^[A-Za-z0-9+/\-_]*={0,2}$/.test(compact);
}

/**
 * Stats of a base64 body: decoded byte length and the first 12 hex chars of
 * the SHA-256 of the decoded bytes (spec §8).
 */
export function base64Stats(s: string): { bytes: number; sha256: string } {
  const buf = Buffer.from(s.replace(/\s+/g, ''), 'base64');
  return { bytes: buf.byteLength, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 12) };
}

/** Truncates to `max` chars with an ellipsis suffix. */
export function truncateChars(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + ELLIPSIS : s;
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes, suffixing `…` when cut. */
export function bytePreview(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const limit = maxBytes - Buffer.byteLength(ELLIPSIS, 'utf8');
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) break;
    out += ch;
    bytes += size;
  }
  return out + ELLIPSIS;
}

/** Normal-log treatment of a string value: base64 redaction, then §8 truncation. */
export function transformLogString(s: string): unknown {
  if (isBase64Candidate(s)) return base64Stats(s);
  return truncateChars(s, STRING_TRUNCATE_CHARS);
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/** `Error` → `{name, message, stack(≤2KB)}` (spec §1). */
export function serializeError(err: Error): SerializedError {
  const out: SerializedError = { name: err.name, message: err.message };
  if (typeof err.stack === 'string') out.stack = truncateChars(err.stack, STACK_MAX_CHARS);
  return out;
}

function isErrorLike(v: unknown): v is Error {
  return v instanceof Error;
}

export interface SafeStringifyOptions {
  /** Drop keys whose name is a secret field name (spec §8). */
  filterSecrets?: boolean;
  /** May return a replacement value for a string (e.g. base64 stats object). */
  transformString?: (s: string) => unknown;
}

const UNDEFINED_SENTINEL = 'undefined';

/**
 * Cycle-safe, throw-safe JSON serialization (spec §1: cycles → `"[circular]"`).
 * - `undefined`/`function`/`symbol`: dropped in objects, `null` in arrays;
 * - `bigint` → JSON string;
 * - `Error` at any depth → `{name, message, stack(≤2KB)}`;
 * - when `filterSecrets`, secret-named keys are dropped;
 * - when `transformString`, string values may be replaced (the replacement is
 *   serialized with the same rules).
 */
export function safeStringify(value: unknown, opts: SafeStringifyOptions = {}): string {
  const seen = new Set<object>();
  const write = (v: unknown): string => {
    if (v === null) return 'null';
    const ty = typeof v;
    if (ty === 'string') {
      const s = v as string;
      const replaced = opts.transformString ? opts.transformString(s) : s;
      if (replaced !== s) return write(replaced);
      return JSON.stringify(s);
    }
    if (ty === 'number') return Number.isFinite(v as number) ? String(v) : 'null';
    if (ty === 'boolean') return String(v);
    if (ty === 'bigint') return JSON.stringify(String(v));
    if (ty === 'undefined' || ty === 'function' || ty === 'symbol') return UNDEFINED_SENTINEL;
    const obj = v as object;
    if (seen.has(obj)) return '"[circular]"';
    if (isErrorLike(v)) return write(serializeError(v));
    seen.add(obj);
    let out: string;
    if (Array.isArray(v)) {
      const items = v.map((item) => {
        const written = write(item);
        return written === UNDEFINED_SENTINEL ? 'null' : written;
      });
      out = `[${items.join(',')}]`;
    } else {
      const parts: string[] = [];
      for (const [key, member] of Object.entries(v as Record<string, unknown>)) {
        if (opts.filterSecrets && isSecretKey(key)) continue;
        const written = write(member);
        if (written === UNDEFINED_SENTINEL) continue;
        parts.push(`${JSON.stringify(key)}:${written}`);
      }
      out = `{${parts.join(',')}}`;
    }
    seen.delete(obj);
    return out;
  };
  const written = write(value);
  return written === UNDEFINED_SENTINEL ? 'null' : written;
}

/**
 * Marker returned by `coerceLogFieldValue` when a field must be skipped
 * (`undefined`/`null` values, functions, symbols — spec §1).
 */
export const FIELD_SKIP: unique symbol = Symbol('mavis.logging.skip');

/**
 * Field value coercion shared by both output formats (spec §1 + §8):
 * - scalars as-is (`bigint` → string);
 * - `Error` → `{name, message, stack(≤2KB)}`;
 * - base64/blob strings > 256 chars → `{bytes, sha256(12hex)}`;
 * - other strings > 200 chars → truncated with `…`;
 * - nested object/array → JSON preview ≤ 512 bytes with `…` suffix;
 * - cycles → `"[circular]"`;
 * - `undefined`/`null` → skip.
 */
export function coerceLogFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) return FIELD_SKIP;
  const ty = typeof value;
  if (ty === 'string') return transformLogString(value as string);
  if (ty === 'number' || ty === 'boolean') return value;
  if (ty === 'bigint') return String(value);
  if (ty === 'function' || ty === 'symbol') return FIELD_SKIP;
  if (isErrorLike(value)) return serializeError(value);
  const json = safeStringify(value, { filterSecrets: true, transformString: transformLogString });
  return bytePreview(json, PREVIEW_MAX_BYTES);
}

/** Coerces a whole field record, dropping secret-named and skipped fields. */
export function coerceLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (isSecretKey(key)) continue;
    const coerced = coerceLogFieldValue(fields[key]);
    if (coerced === FIELD_SKIP) continue;
    out[key] = coerced;
  }
  return out;
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

export interface RenderableEvent {
  ts: Date;
  level: LogLevel;
  ns: string;
  msg: string;
}

/** Local wall-clock time `HH:MM:SS.mmm` as in the spec's text example. */
export function formatTextTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/** Text values must never contain a raw newline: one line per event (spec §1). */
function escapeText(s: string): string {
  return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function renderTextValue(v: unknown): string {
  if (typeof v === 'string') return escapeText(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return v.toString();
  return safeStringify(v, { filterSecrets: true });
}

/** `15:47:08.123 INFO  [mcode:cas] put bytes=1024 ref=ab12cd34ef56 durationMs=3` */
export function renderTextLine(ev: RenderableEvent, fields: Record<string, unknown>): string {
  let line = `${formatTextTime(ev.ts)} ${LEVEL_LABEL[ev.level].padEnd(5)} [${ev.ns}] ${escapeText(ev.msg)}`;
  for (const [key, value] of Object.entries(fields)) {
    line += ` ${key}=${renderTextValue(value)}`;
  }
  return line;
}

/** `{"ts":"...","level":"info","ns":"mcode:cas","msg":"put",...fields}` */
export function renderJsonLine(ev: RenderableEvent, fields: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {
    ts: ev.ts.toISOString(),
    level: ev.level,
    ns: ev.ns,
    msg: ev.msg,
  };
  for (const [key, value] of Object.entries(fields)) payload[key] = value;
  return safeStringify(payload);
}
