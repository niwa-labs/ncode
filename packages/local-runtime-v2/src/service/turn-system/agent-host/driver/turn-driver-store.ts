/**
 * W04 part B — durable persistence for the turn-driver state.
 *
 * The driver never writes storage directly: it speaks the `DurableLogPort`
 * seam (the wave-1 contract behind `@mavis/durable-seam`), one appendBatch =
 * one durable commit, deterministic entry ids per conversation/revision, and
 * replay detection by content hash — the same discipline the seam's
 * T_accept/T_release/T_complete use. A crash between driver transitions
 * therefore leaves either the old or the new checkpoint, never a half of
 * either (§2.6 I11).
 *
 * @module
 */

import {
  canonicalJson,
  hashString,
  type DurableLogPort,
  type PortEntry,
} from '@mavis/durable-seam';
import type {
  ExecutorBinding,
  TurnDriverCheckpoint,
  TurnDriverStateRecord,
  TurnDriverStoreResult,
} from './driver-contracts.js';

export type { TurnDriverCheckpoint, TurnDriverStoreResult };

/** Entry kinds this store writes (app namespace `mcode.`). */
export const TURN_DRIVER_ENTRY_KINDS = {
  state: 'mcode.turn-driver.state',
} as const;

/** Deterministic entry id of one conversation's state revision. */
export function turnDriverStateEntryId(conversationId: string, revision: number): string {
  return `turn-driver:${conversationId}:r${revision}`;
}

/** Whether a stored entry is a turn-driver state record of `conversationId`. */
function isDriverStateEntry(entry: PortEntry, conversationId?: string): boolean {
  return (
    entry.kind === TURN_DRIVER_ENTRY_KINDS.state &&
    (conversationId === undefined ||
      (entry.payload as { conversationId?: unknown }).conversationId === conversationId)
  );
}

/** Parse + validate a stored payload as a driver state record. */
function parseRecord(entry: PortEntry): TurnDriverStateRecord | undefined {
  const payload = entry.payload as Partial<TurnDriverStateRecord> | null;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.conversationId !== 'string' ||
    typeof payload.revision !== 'number' ||
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 1
  ) {
    return undefined;
  }
  return payload as TurnDriverStateRecord;
}

/** Error surface of the driver store (fail-closed, no silent legacy path). */
export type TurnDriverStoreErrorCode =
  | 'CONVERSATION_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'OWNER_LOST'
  | 'TORN_TAIL'
  | 'CORRUPT_STATE';

export class TurnDriverStoreError extends Error {
  override name = 'TurnDriverStoreError';

  constructor(
    readonly code: TurnDriverStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Read snapshot of one conversation's driver state. */
export interface TurnDriverStateView {
  readonly revision: number;
  readonly record?: TurnDriverStateRecord;
}

export interface TurnDriverSaveInput {
  readonly conversationId: string;
  /** Revision the caller last observed; the save CASes on it. */
  readonly expectedRevision: number;
  readonly checkpoint?: TurnDriverCheckpoint;
  readonly binding?: ExecutorBinding;
  readonly pendingBoundaryDrafts?: readonly unknown[];
}

/**
 * Durable turn-driver state store over a `DurableLogPort`.
 *
 * Concurrency: the port's single-writer fencing plus the revision CAS make a
 * second driver's write fail closed (`REVISION_CONFLICT` / `OWNER_LOST`)
 * instead of racing (§2.6 I01/I07).
 */
/**
 * The driver-store surface {@link DurableTurnDriver} consumes, as a port:
 * keyed by conversation id (the product session id string), synchronous.
 * Extracted so the per-session routing store (one pi port per session file)
 * satisfies the driver without reaching into this class's privates.
 */
export interface TurnDriverStorePort {
  /** Newest state record of the conversation (revision 0 when none). */
  read(conversationId: string): TurnDriverStateView;
  /** Latest committed checkpoint, if the conversation has an open run. */
  readCheckpoint(conversationId: string): TurnDriverCheckpoint | undefined;
  /** Commit the next revision atomically (same-revision replay replays). */
  save(input: TurnDriverSaveInput): Promise<TurnDriverStoreResult>;
}

export class DurableTurnDriverStore implements TurnDriverStorePort {
  readonly #port: DurableLogPort;
  readonly #windowBytes: number;

  constructor(port: DurableLogPort, options?: { readonly replayWindowBytes?: number }) {
    this.#port = port;
    this.#windowBytes = options?.replayWindowBytes ?? 8 * 1024 * 1024;
  }

  /** Newest state record of the conversation (revision 0 when none). */
  read(conversationId: string): TurnDriverStateView {
    let afterSeq = 0;
    let newest: TurnDriverStateRecord | undefined;
    let torn = false;
    for (;;) {
      const delta = this.#port.readDeltaChecked(afterSeq, this.#windowBytes);
      for (const entry of delta.entries) {
        if (!isDriverStateEntry(entry, conversationId)) continue;
        const record = parseRecord(entry);
        // A malformed record is skipped for reads, but the torn flag below
        // still guards the scan itself; writers never extend a bad prefix.
        if (record && (newest === undefined || record.revision > newest.revision)) newest = record;
      }
      if (delta.tornTail !== null) {
        torn = true;
        break;
      }
      if (delta.nextAfterSeq === null) break;
      afterSeq = delta.nextAfterSeq;
    }
    if (torn && newest === undefined) {
      throw new TurnDriverStoreError(
        'TORN_TAIL',
        `Driver state scan for ${conversationId} stopped on a torn tail before any record`,
      );
    }
    return { revision: newest?.revision ?? 0, record: newest };
  }

  /** Latest committed checkpoint, if the conversation has an open run. */
  readCheckpoint(conversationId: string): TurnDriverCheckpoint | undefined {
    return this.read(conversationId).record?.checkpoint;
  }

  /**
   * Commit the next revision atomically. Writing the SAME revision content
   * again (crash-retry) replays the original commit instead of appending.
   */
  async save(input: TurnDriverSaveInput): Promise<TurnDriverStoreResult> {
    const { conversationId, expectedRevision } = input;
    const revision = expectedRevision + 1;
    const entryId = turnDriverStateEntryId(conversationId, revision);
    const existing = this.#port.getEntry(entryId);
    if (existing !== undefined) {
      const record = parseRecord(existing);
      const recordHash = record === undefined ? undefined : hashString(canonicalJson(record));
      const nextHash = hashString(
        canonicalJson({
          conversationId,
          revision,
          ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
          ...(input.binding === undefined ? {} : { binding: input.binding }),
          ...(input.pendingBoundaryDrafts === undefined
            ? {}
            : { pendingBoundaryDrafts: input.pendingBoundaryDrafts }),
        }),
      );
      if (recordHash !== nextHash) {
        throw new TurnDriverStoreError(
          'REVISION_CONFLICT',
          `Driver state revision ${revision} of ${conversationId} already exists with different content`,
        );
      }
      return { revision, status: 'replayed' };
    }
    // CAS: the current head revision must still be the expected one.
    const current = this.read(conversationId);
    if (current.revision !== expectedRevision) {
      throw new TurnDriverStoreError(
        'REVISION_CONFLICT',
        `Driver state of ${conversationId} is at revision ${current.revision}, expected ${expectedRevision}`,
      );
    }
    const record: TurnDriverStateRecord = {
      conversationId,
      revision,
      ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
      ...(input.binding === undefined ? {} : { binding: input.binding }),
      ...(input.pendingBoundaryDrafts === undefined
        ? {}
        : { pendingBoundaryDrafts: input.pendingBoundaryDrafts }),
    };
    let commit;
    try {
      commit = await this.#port.appendBatch([
        { id: entryId, kind: TURN_DRIVER_ENTRY_KINDS.state, payload: record as never },
      ]);
    } catch (error) {
      throw new TurnDriverStoreError(
        'OWNER_LOST',
        `Driver state commit for ${conversationId} revision ${revision} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (commit.seq <= 0) {
      throw new TurnDriverStoreError('CORRUPT_STATE', `Driver state commit returned seq ${commit.seq}`);
    }
    return { revision, status: 'committed' };
  }
}
