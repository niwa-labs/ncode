import { NcodeProtocolError, NcodeVersionError } from './errors.js';
import type { ThreadEvent } from './types.js';

export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Parses one stdout line. Returns `undefined` for blank lines.
 *
 * Unknown event types are passed through; only the shared envelope and the fields the SDK relies
 * on are validated.
 */
export function parseEventLine(line: string): ThreadEvent | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new NcodeProtocolError(`ncode stdout is not JSON: ${truncate(text)}`, { cause: error });
  }
  if (!isRecord(value)) {
    throw new NcodeProtocolError(`ncode stdout line is not a JSON object: ${truncate(text)}`);
  }
  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new NcodeVersionError(
      `Unsupported ncode event schemaVersion ${JSON.stringify(value.schemaVersion)}; this SDK supports ${String(SUPPORTED_SCHEMA_VERSION)}.`,
    );
  }
  if (typeof value.type !== 'string' || typeof value.sessionId !== 'string') {
    throw new NcodeProtocolError(`ncode event is missing type or sessionId: ${truncate(text)}`);
  }
  if (value.type.startsWith('item.') && !isItem(value.item)) {
    throw new NcodeProtocolError(
      `ncode ${value.type} event has an invalid item: ${truncate(text)}`,
    );
  }
  if (value.type === 'exec.completed' && !isResult(value.result)) {
    throw new NcodeProtocolError(`ncode exec.completed has an invalid result: ${truncate(text)}`);
  }
  return value as unknown as ThreadEvent;
}

function isItem(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function isResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === SUPPORTED_SCHEMA_VERSION &&
    typeof value.status === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
