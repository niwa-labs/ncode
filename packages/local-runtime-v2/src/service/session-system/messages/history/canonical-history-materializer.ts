import { randomUUID } from 'node:crypto';
import { access, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@mavis/logging';
// Ш6 (integration plan): the streaming reader of the legacy mcode v2 session
// directory — `messages.jsonl` canonical history — used to read the target
// file without materializing it whole.
import { openV2Session } from '@mavis/legacy-history';

import {
  canonicalActiveHistoryRevision,
  selectCanonicalHistorySource,
  type CanonicalHistoryEnvelope,
  type CanonicalHistoryFileAdapter,
} from '../../sessions/representation/canonical-history-contract.js';
import { decodeCanonicalHistoryEnvelope } from '../../../../infra/file/canonical-history.js';
import {
  normalizeLegacyHistoryForMessages,
  type LegacyHistoryNormalizationResult,
} from './legacy-history-normalizer.js';
import type { SessionHistoryPaths } from './session-history-paths.js';

/** Spec §4 registry: `mcode:turn` is local-runtime-v2's namespace. */
const materializerLog = createLogger('mcode:turn');

type CanonicalHistoryMigrationSource = 'ledger-snapshot' | 'sqlite-rows' | 'sqlite-blob' | 'empty';

interface CanonicalHistoryMigrationCheckpoint {
  readonly sessionId: string;
  readonly migratedAtMs: number;
  readonly source: CanonicalHistoryMigrationSource;
  readonly messageCount: number;
  readonly targetRevision: string;
}

interface CanonicalHistoryLegacySources {
  /**
   * Integration plan R4: every source read may receive an optional progress
   * listener. Streaming sources report `{recordsRead}` as they deliver; the
   * array-returning implementations of today simply ignore the callback (the
   * materializer still emits its own phase-level events around the read).
   */
  readLedgerSnapshot(
    sessionId: string,
    onProgress?: CanonicalHistorySourceProgressListener,
  ): Promise<readonly CanonicalHistoryEnvelope[] | undefined>;
  readSqliteRows(
    sessionId: string,
    onProgress?: CanonicalHistorySourceProgressListener,
  ): Promise<readonly CanonicalHistoryEnvelope[]>;
  readSqliteBlob(
    sessionId: string,
    onProgress?: CanonicalHistorySourceProgressListener,
  ): Promise<readonly CanonicalHistoryEnvelope[]>;
}

/** Progress reported by one legacy source while its records are being read. */
export interface CanonicalHistorySourceProgress {
  /** Which authoritative source is delivering. */
  readonly source: 'ledger-snapshot' | 'sqlite-rows' | 'sqlite-blob';
  /** Records delivered so far by this source read. */
  readonly recordsRead: number;
}

/** Receives {@link CanonicalHistorySourceProgress} from a legacy source read. */
export type CanonicalHistorySourceProgressListener = (
  progress: CanonicalHistorySourceProgress,
) => void;

/**
 * Phase-level progress of one materialization (integration plan R4: the
 * phases follow the import pipeline of the test architecture §10.3 — scan →
 * normalize → verify → complete; externalization/seed belong to the import
 * sink and the durable provider, not to this module).
 */
export interface CanonicalHistoryMaterializerProgress {
  readonly sessionId: string;
  readonly phase: 'scan' | 'normalize' | 'verify' | 'complete';
  /** The authoritative source once it is selected (absent while scanning). */
  readonly source?: CanonicalHistoryMigrationSource;
  /** Records delivered by the selected source so far (absent before selection). */
  readonly recordsRead?: number;
  /** Source bytes observed so far, when the reader reports a byte cursor. */
  readonly bytesRead?: number;
  /** Records in the verified canonical target (set on `complete`). */
  readonly targetRecords?: number;
}

/** Receives {@link CanonicalHistoryMaterializerProgress} phases. */
export type CanonicalHistoryMaterializerProgressListener = (
  progress: CanonicalHistoryMaterializerProgress,
) => void;

interface CanonicalHistoryMigrationCheckpoints {
  getCheckpoint(sessionId: string): Promise<CanonicalHistoryMigrationCheckpoint | undefined>;
  upsertCheckpoint(checkpoint: CanonicalHistoryMigrationCheckpoint): Promise<void>;
}

export interface CanonicalHistoryLegacyMigration {
  readonly sources: CanonicalHistoryLegacySources;
  readonly checkpoints: CanonicalHistoryMigrationCheckpoints;
}

interface CanonicalHistoryMaterializerOptions {
  readonly sessionId: string;
  readonly paths: SessionHistoryPaths;
  readonly files: CanonicalHistoryFileAdapter;
  readonly legacyHistory?: CanonicalHistoryLegacyMigration;
  /**
   * Ш6: read the target `messages.jsonl` (the legacy mcode v2 canonical
   * history) through `@mavis/legacy-history` — streaming, line-bounded, with the
   * adapter's format validation — instead of the whole-file parse. Every
   * decoded record still passes the canonical envelope decoder, so the
   * accepted-record set and the produced values are exactly the legacy
   * read's. Composed only by the durable provider; the JSONL (legacy default)
   * materialization keeps its exact path.
   */
  readonly readTargetViaV2Adapter?: boolean;
  /**
   * Integration plan R4: optional progress channel of the materialization.
   * Receives the `scan → normalize → verify → complete` phases with the
   * observed counters; sources receive a scoped listener through their
   * extended signatures. Diagnostic only — no behavior depends on it.
   */
  readonly onProgress?: CanonicalHistoryMaterializerProgressListener;
  readonly nowMs: () => number;
}

type MaterializationMode =
  | 'published'
  | 'matched-target'
  | 'target-contained-baseline'
  | 'target-only'
  | 'empty-target-replaced'
  | 'suffix-prepended';

interface MaterializedHistory {
  readonly records: readonly CanonicalHistoryEnvelope[];
  readonly materialization: MaterializationMode;
}

export async function ensureCanonicalHistoryMaterialized(
  options: CanonicalHistoryMaterializerOptions,
): Promise<void> {
  if (!options.legacyHistory) {
    if (!(await targetExists(options)))
      await options.files.publishInitial(options.paths.messages, []);
    return;
  }

  const emitProgress = (
    phase: CanonicalHistoryMaterializerProgress['phase'],
    fields: Partial<Omit<CanonicalHistoryMaterializerProgress, 'sessionId' | 'phase'>> = {},
  ): void => {
    options.onProgress?.({ sessionId: options.sessionId, phase, ...fields });
  };

  const checkpoint = await options.legacyHistory.checkpoints.getCheckpoint(options.sessionId);
  if (checkpoint) {
    if (!(await targetExists(options))) {
      throw new Error(`Canonical history target is missing after migration: ${options.sessionId}`);
    }
    return;
  }

  emitProgress('scan');
  const target = options.readTargetViaV2Adapter === true
    ? await readTargetViaV2Adapter(options, emitProgress)
    : await options.files.readTarget(options.paths.messages);
  const selected = await selectLegacySource(options, emitProgress);
  emitProgress('scan', {
    source: selected.source,
    recordsRead: selected.records.length,
  });
  const normalized = normalizeSelectedHistory(options.sessionId, selected.records);
  emitProgress('normalize', {
    source: selected.source,
    recordsRead: selected.records.length,
  });
  const materialized =
    target === undefined
      ? await publishInitialTarget(options, normalized.items)
      : await verifyExistingTarget(options, target, normalized.items);
  // The declared phase sequence is scan → normalize → verify → complete
  // (diagnostic only); the verification step below was previously silent.
  emitProgress('verify', {
    source: selected.source,
    recordsRead: selected.records.length,
  });
  const verified = await verifyMaterializedTarget(options, materialized.records);
  const revision = canonicalActiveHistoryRevision(verified);
  emitProgress('complete', {
    source: selected.source,
    recordsRead: selected.records.length,
    targetRecords: verified.length,
  });
  await writeMaterializationReport(options, {
    source: selected.source,
    inputMessageCount: selected.records.length,
    targetMessageCount: verified.length,
    targetRevision: revision,
    materialization: materialized.materialization,
    normalization: normalized,
  });
  await options.legacyHistory.checkpoints.upsertCheckpoint({
    sessionId: options.sessionId,
    migratedAtMs: options.nowMs(),
    source: selected.source,
    messageCount: verified.length,
    targetRevision: revision,
  });
}

async function targetExists(options: CanonicalHistoryMaterializerOptions): Promise<boolean> {
  return options.files.targetExists
    ? options.files.targetExists(options.paths.messages)
    : (await options.files.readTarget(options.paths.messages)) !== undefined;
}

/**
 * Ш6: the target observation read through `@mavis/legacy-history`. The adapter
 * contributes the streaming, line-bounded file read and its envelope format
 * validation; the canonical envelope decoder remains the single validation
 * and value authority, so an accepted file decodes to exactly the records the
 * legacy `files.readTarget` produces. Tolerance matches the legacy
 * `readActive` reader: a malformed line (JSON/shape through the adapter, or a
 * canonical decode rejection) is skipped and counted, never fatal.
 */
async function readTargetViaV2Adapter(
  options: CanonicalHistoryMaterializerOptions,
  emitProgress: (phase: CanonicalHistoryMaterializerProgress['phase'], fields: Omit<CanonicalHistoryMaterializerProgress, 'sessionId' | 'phase'>) => void,
): Promise<readonly CanonicalHistoryEnvelope[] | undefined> {
  const exists = options.files.targetExists
    ? await options.files.targetExists(options.paths.messages)
    : await sessionMessagesFileExists(options.paths.messages);
  if (!exists) return undefined;
  const reader = openV2Session(options.paths.sessionDir);
  const records: CanonicalHistoryEnvelope[] = [];
  let skipped = 0;
  let bytesRead = 0;
  const result = await reader.readEnvelopes(
    (envelope, _lineNo, _physicalLine, consumedBytes) => {
      bytesRead = consumedBytes;
      try {
        records.push(decodeCanonicalHistoryEnvelope(envelope));
      } catch {
        skipped += 1;
      }
    },
    {
      formatErrors: 'skip',
      onFormatError: () => {
        skipped += 1;
      },
    },
  );
  emitProgress('scan', { recordsRead: records.length, bytesRead });
  materializerLog.debug('canonical target read through the v2 adapter', {
    sessionId: options.sessionId,
    lines: result.lines,
    skipped,
  });
  return records;
}

async function sessionMessagesFileExists(messagesPath: string): Promise<boolean> {
  try {
    await access(messagesPath);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function selectLegacySource(
  options: CanonicalHistoryMaterializerOptions,
  emitProgress: (phase: CanonicalHistoryMaterializerProgress['phase'], fields: Omit<CanonicalHistoryMaterializerProgress, 'sessionId' | 'phase'>) => void,
): Promise<{
  readonly source: CanonicalHistoryMigrationSource;
  readonly records: readonly CanonicalHistoryEnvelope[];
}> {
  const legacy = options.legacyHistory;
  if (!legacy) return { source: 'empty', records: [] };
  // R4: the selected source receives a scoped progress listener, so a
  // streaming implementation can report its record cursor without knowing
  // this module; today's array-returning readers ignore the callback and the
  // materializer emits the phase event after the read returns.
  const onSourceProgress: CanonicalHistorySourceProgressListener = (progress) => {
    emitProgress('scan', { source: progress.source, recordsRead: progress.recordsRead });
  };
  const selected = await selectCanonicalHistorySource({
    readTarget: async () => undefined,
    readAuthoritativeLedgerSnapshot: () =>
      legacy.sources.readLedgerSnapshot(options.sessionId, onSourceProgress),
    readSqliteRows: () => legacy.sources.readSqliteRows(options.sessionId, onSourceProgress),
    readSqliteBlob: () => legacy.sources.readSqliteBlob(options.sessionId, onSourceProgress),
  });
  if (selected.source === 'target') {
    throw new Error(`Canonical history source selection is invalid: ${options.sessionId}`);
  }
  return { source: selected.source, records: selected.records };
}

function normalizeSelectedHistory(
  sessionId: string,
  records: readonly CanonicalHistoryEnvelope[],
): LegacyHistoryNormalizationResult<CanonicalHistoryEnvelope> {
  return normalizeLegacyHistoryForMessages(
    records,
    {
      message: (envelope) => envelope.message,
      replaceAssistantContent: (envelope, content) => ({
        ...envelope,
        message: { ...envelope.message, content },
      }),
    },
    { tag: sessionId },
  );
}

async function publishInitialTarget(
  options: CanonicalHistoryMaterializerOptions,
  candidate: readonly CanonicalHistoryEnvelope[],
): Promise<MaterializedHistory> {
  const publication = await options.files.publishInitial(options.paths.messages, candidate);
  if (publication.status === 'published') {
    return { records: publication.records, materialization: 'published' };
  }
  return verifyExistingTarget(options, publication.records, candidate);
}

async function verifyExistingTarget(
  options: CanonicalHistoryMaterializerOptions,
  observedTarget: readonly CanonicalHistoryEnvelope[],
  candidate: readonly CanonicalHistoryEnvelope[],
): Promise<MaterializedHistory> {
  const target = await options.files.readStrict(options.paths.messages);
  if (canonicalActiveHistoryRevision(observedTarget) !== canonicalActiveHistoryRevision(target)) {
    throw new Error(
      `Canonical history target changed during materialization: ${options.sessionId}`,
    );
  }
  if (canonicalActiveHistoryRevision(target) !== canonicalActiveHistoryRevision(candidate)) {
    throw new Error(`Canonical history materialization is ambiguous: ${options.sessionId}`);
  }
  return { records: target, materialization: 'matched-target' };
}

async function verifyMaterializedTarget(
  options: CanonicalHistoryMaterializerOptions,
  expected: readonly CanonicalHistoryEnvelope[],
): Promise<readonly CanonicalHistoryEnvelope[]> {
  const verified = await options.files.readStrict(options.paths.messages);
  if (canonicalActiveHistoryRevision(verified) !== canonicalActiveHistoryRevision(expected)) {
    throw new Error(`Canonical history materialization verification failed: ${options.sessionId}`);
  }
  return verified;
}

async function writeMaterializationReport(
  options: CanonicalHistoryMaterializerOptions,
  report: {
    readonly source: CanonicalHistoryMigrationSource;
    readonly inputMessageCount: number;
    readonly targetMessageCount: number;
    readonly targetRevision: string;
    readonly materialization: MaterializationMode;
    readonly normalization: LegacyHistoryNormalizationResult<CanonicalHistoryEnvelope>;
  },
): Promise<void> {
  if (
    report.source === 'empty' &&
    report.materialization === 'published' &&
    report.normalization.warnings.length === 0
  ) {
    return;
  }
  await mkdir(options.paths.reports, { recursive: true, mode: 0o700 });
  const path = join(options.paths.reports, 'history-materialization.json');
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            sessionId: options.sessionId,
            source: report.source,
            migratedAtMs: options.nowMs(),
            inputMessageCount: report.inputMessageCount,
            targetMessageCount: report.targetMessageCount,
            targetRevision: report.targetRevision,
            materialization: report.materialization,
            normalization: {
              stats: report.normalization.stats,
              warnings: report.normalization.warnings,
            },
          },
          null,
          2,
        )}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
