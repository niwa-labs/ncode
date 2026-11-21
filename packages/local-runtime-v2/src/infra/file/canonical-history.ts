export {
  CanonicalHistoryJsonlDataSource,
  assertCanonicalHistorySequence,
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  decodeCanonicalHistoryEnvelope,
  inspectCanonicalHistorySequence,
  sanitizeCanonicalTurnConfig,
  selectCanonicalHistorySource,
} from './canonical-history-jsonl.js';

export { JsonlAppendCommitUncertainError } from './jsonl.js';

export type {
  CanonicalHistoryArtifact,
  CanonicalHistoryEnvelope,
  CanonicalHistoryJsonlDataSourceOptions,
  CanonicalHistoryMessage,
  CanonicalHistoryPublication,
  CanonicalHistorySequenceInspection,
  CanonicalHistorySourceReaders,
  CanonicalHistorySourceSelection,
  CanonicalTurnConfig,
  CanonicalTurnConfigTool,
} from './canonical-history-jsonl.js';

/** Maps session and snapshot identifiers to the historical on-disk filenames. */
export function safeHistoryPathSegment(value: string): string {
  return (
    value
      .replaceAll(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
      .replaceAll(/^\.+/gu, '')
      .slice(0, 180) || 'snapshot'
  );
}

/** Encoded suffix of the runtime's dated session directories. */
export function encodedSessionHistoryId(sessionId: string): string {
  return `session_${Buffer.from(sessionId || 'unknown-session', 'utf8')
    .toString('base64url')
    .slice(0, 180)}`;
}
