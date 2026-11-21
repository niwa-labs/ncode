/**
 * Fixed one-turn image residency (owner decision 2026-11-08).
 * An image is visible only in the turn that receives or explicitly re-reads
 * it. The next actual turn expires all resident images in one batch. History
 * reseeds and compaction replacements do not advance this lifetime.
 *
 * Artifacts remain content-addressed and readable after eviction. Residency
 * also records the newly observed message occurrence: re-reading the same
 * content must not resurrect old image blocks in the cached prefix.
 * The token budget may evict an image earlier within its current turn.
 */

import { createHash } from 'node:crypto';

import { decodeEntryPayload, type RecordImageBlock } from '@mavis/convert-to-llm';
import type { Entry } from '@mavis/durable-backend-sqlite-zstd';
import { createLogger } from '@mavis/logging';

import type { ImageArtifactStore } from '../../session-system/messages/history/image-artifact-store.js';
import type { ContextWireResidency, ContextWirePageStatus } from './context-wire.js';

const log = createLogger('mcode:compaction');

/** Default resident-image token budget (owner decision: 150k on a 1M window). */
export const DEFAULT_RESIDENT_IMAGE_BUDGET_TOKENS = 150_000;

/** Fixed product policy; not an environment or constructor option. */
export const RESIDENT_IMAGE_TURNS = 1;

/** The token-estimation heuristic shared with the trigger axis (chars/4). */
const CHARS_PER_TOKEN = 4;

/** Env knob: the resident-image token budget. */
const RESIDENT_IMAGE_BUDGET_ENV = 'MCODE_RESIDENT_IMAGE_BUDGET_TOKENS';

/**
 * Resolves the resident-image token budget (wave-0 item 0.5). Unset follows
 * the owner default (150k tokens); an explicit value must be a non-negative
 * safe integer (0 disables residency — everything stays the placeholder).
 * Invalid values fail closed with a clear error, like every context knob.
 */
export function resolveResidentImageBudgetTokens(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[RESIDENT_IMAGE_BUDGET_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RESIDENT_IMAGE_BUDGET_TOKENS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Unsupported ${RESIDENT_IMAGE_BUDGET_ENV} value '${raw}' (a non-negative integer is expected; 0 disables image residency)`,
    );
  }
  return value;
}

/** One tracked image, keyed by content (insertion order = oldest first). */
interface TrackedImage {
  readonly sha256: string;
  readonly mimeType: string;
  /** Artifact path for an OFFLOADED image (`undefined` for inline bytes). */
  readonly artifactPath: string | undefined;
  /** Base64 data length in characters (the token-estimate input). */
  readonly dataChars: number;
}

/**
 * The minted handle: the fields the compile seam reads (`sha256` for the
 * `resident@<sha16>` wire identity, `sourcePath` for the artifact lookup).
 */
export interface ResidencyPageHandle {
  readonly id: string;
  readonly sha256: string;
  readonly mime: string;
  readonly width: undefined;
  readonly height: undefined;
  readonly bytes: number;
  readonly sourcePath: string | undefined;
  readonly stale: false;
  readonly replacedBy: undefined;
  readonly previousSha256: undefined;
}

export interface TurnImageResidencyOptions {
  /** The artifact store resolving an offloaded image's bytes (wire mode). */
  readonly artifacts?: ImageArtifactStore;
  /** Memoized read capacity of the artifact resolution path. */
  readonly readMemoCapacity?: number;
}

/** Current-turn image decisions fed by actual turn boundaries and new commits. */
export class TurnImageResidency {
  /** Tracked images per session, keyed by content sha256, oldest first. */
  private readonly tracked = new Map<string, Map<string, TrackedImage>>();
  /** Estimated resident tokens per session (the budget accounting). */
  private readonly residentTokens = new Map<string, number>();
  /** New message occurrences admitted in this turn; historical copies stay stubs. */
  private readonly currentEntries = new Map<string, Set<string>>();
  readonly artifacts: ImageArtifactStore | undefined;
  private readonly readMemo: Map<string, string>;
  private readonly readMemoCapacity: number;

  constructor(
    readonly budgetTokens: number = resolveResidentImageBudgetTokens(),
    options?: TurnImageResidencyOptions,
  ) {
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0) {
      throw new Error(
        `TurnImageResidency: budgetTokens must be a non-negative integer, got ${budgetTokens}`,
      );
    }
    this.artifacts = options?.artifacts;
    this.readMemoCapacity = options?.readMemoCapacity ?? 64;
    this.readMemo = new Map();
  }

  /**
   * The session-bound seam view: `pageOf(entry)` resolves THIS session's
   * tracked images, `statusOf` answers the residency decision, `readImage`
   * resolves an offloaded image's bytes back out of the artifact store.
   */
  forSession(sessionId: string): ContextWireResidency {
    return {
      mmu: { statusOf: (page) => this.statusOf(sessionId, page.sha256) },
      pageOf: (entry: Entry) => this.pageFor(sessionId, entry),
      ...(this.artifacts !== undefined
        ? {
            readImage: (page: { readonly sha256: string }) => {
              const data = this.readImage(page.sha256);
              if (data === undefined) return undefined;
              return {
                data,
                mimeType:
                  this.tracked.get(sessionId)?.get(page.sha256)?.mimeType ??
                  'application/octet-stream',
              };
            },
          }
        : {}),
    };
  }

  /** Expire this turn's images together; stored artifacts are not deleted. */
  beginTurn(sessionId: string): readonly string[] {
    const expired = [...(this.tracked.get(sessionId)?.keys() ?? [])];
    this.tracked.delete(sessionId);
    this.currentEntries.delete(sessionId);
    this.residentTokens.delete(sessionId);
    if (expired.length > 0) {
      log.debug('resident images expired at the turn boundary (one batch)', {
        session_id: sessionId,
        lifetime_turns: RESIDENT_IMAGE_TURNS,
        evicted_entries: expired.length,
      });
    }
    return expired;
  }

  /** Admit images from newly committed occurrences, including explicit re-reads. */
  observeEntries(sessionId: string, entries: readonly Entry[]): void {
    if (this.budgetTokens === 0 || entries.length === 0) return;
    let images = this.tracked.get(sessionId);
    if (images === undefined) {
      images = new Map();
      this.tracked.set(sessionId, images);
      this.residentTokens.set(sessionId, 0);
    }
    let currentEntries = this.currentEntries.get(sessionId);
    if (!currentEntries) {
      currentEntries = new Set();
      this.currentEntries.set(sessionId, currentEntries);
    }
    let tokens = this.residentTokens.get(sessionId) ?? 0;
    for (const entry of entries) {
      const image = firstImageOf(entry);
      if (image === undefined) continue;
      currentEntries.add(entry.id);
      const existing = images.get(image.sha256);
      if (existing !== undefined) {
        // Deduplicate bytes/accounting, but admit only this new occurrence.
        continue;
      }
      const tracked: TrackedImage = {
        sha256: image.sha256,
        mimeType: image.mimeType,
        artifactPath: image.artifactPath,
        dataChars: image.dataChars,
      };
      images.set(image.sha256, tracked);
      // Over budget: evict OLDEST images (this one included, when it alone
      // cannot fit) until the accounting holds — the budget is the only
      // earlier-than-due eviction besides a compaction cut (canon §2.5).
      while (tokens + imageTokens(tracked) > this.budgetTokens && images.size > 0) {
        const oldestSha = images.keys().next().value;
        if (typeof oldestSha !== 'string') break;
        const oldest = images.get(oldestSha)!;
        images.delete(oldestSha);
        tokens -= imageTokens(oldest);
      }
      if (tokens + imageTokens(tracked) > this.budgetTokens) {
        // The image alone exceeds the budget: digest-only (never admitted).
        continue;
      }
      tokens += imageTokens(tracked);
    }
    this.residentTokens.set(sessionId, tokens);
  }

  /** Diagnostics: the session's resident-image accounting. */
  stats(sessionId: string): { readonly entries: number; readonly tokens: number } {
    return {
      entries: this.tracked.get(sessionId)?.size ?? 0,
      tokens: this.residentTokens.get(sessionId) ?? 0,
    };
  }

  private statusOf(sessionId: string, sha256: string): ContextWirePageStatus {
    return this.tracked.get(sessionId)?.has(sha256) ? 'resident' : 'new';
  }

  private pageFor(sessionId: string, entry: Entry): ResidencyPageHandle | undefined {
    const image = firstImageOf(entry);
    if (image === undefined) return undefined;
    if (!this.currentEntries.get(sessionId)?.has(entry.id)) return undefined;
    if (!this.tracked.get(sessionId)?.has(image.sha256)) return undefined;
    return {
      id: entry.id,
      sha256: image.sha256,
      mime: image.mimeType,
      width: undefined,
      height: undefined,
      bytes: image.dataChars,
      sourcePath: image.artifactPath,
      stale: false,
      replacedBy: undefined,
      previousSha256: undefined,
    };
  }

  /** Resolves an offloaded image's base64 back out of the artifact store (memoized). */
  private readImage(sha256: string): string | undefined {
    if (this.artifacts === undefined) return undefined;
    const memo = this.readMemo.get(sha256);
    if (memo !== undefined) return memo;
    const data = this.artifacts.readData(sha256);
    if (data === undefined) return undefined;
    this.readMemo.delete(sha256);
    this.readMemo.set(sha256, data);
    while (this.readMemo.size > this.readMemoCapacity) {
      const oldest = this.readMemo.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.readMemo.delete(oldest);
    }
    return data;
  }
}

/** Token estimate of one tracked image (the same chars/4 heuristic as the trigger axis). */
function imageTokens(image: TrackedImage): number {
  return Math.ceil(image.dataChars / CHARS_PER_TOKEN);
}

/** One image block of an entry payload — inline bytes or an artifact reference. */
interface TrackedCandidate {
  readonly sha256: string;
  readonly mimeType: string;
  readonly artifactPath: string | undefined;
  readonly dataChars: number;
}

/** Extracts an entry's FIRST image block (inline or reference), content-addressed. */
function firstImageOf(entry: Entry): TrackedCandidate | undefined {
  if (entry.kind !== 'session.message') return undefined;
  const decoded = decodeEntryPayload(entry.kind, entry.payload);
  const message = decoded.messages[0];
  if (message === undefined) return undefined;
  for (const part of message.parts) {
    if (part.type !== 'image') continue;
    if (part.ref !== undefined) {
      // Offloaded: the log carries the reference; the lifetime key is the
      // content address and the byte estimate derives from the stored size
      // (base64 ≈ 4/3 of the bytes).
      return {
        sha256: part.ref.sha256,
        mimeType: part.mimeType,
        artifactPath: part.ref.artifact,
        dataChars: Math.ceil((part.ref.bytes * 4) / 3),
      };
    }
    if (part.data !== undefined) {
      return {
        sha256: createHash('sha256').update(part.data, 'utf8').digest('hex'),
        mimeType: part.mimeType,
        artifactPath: undefined,
        dataChars: part.data.length,
      };
    }
  }
  return undefined;
}

export type { RecordImageBlock };
