/**
 * Wave 2 (canon 05 §2.5, items 2.1/2.2): the image OFFLOAD transform — the
 * receipt boundary where an inline image block (a read tool result, an
 * attachment) becomes an artifact.
 *
 * `offloadMessageImages` walks the messages about to enter the canonical
 * history, writes every inline image's bytes into the content-addressed
 * {@link ImageArtifactStore} and REPLACES the block with the reference shape
 * `{type:'image', mimeType, sha256, artifact, bytes}` — the base64 never
 * reaches the log. Re-applying the transform is a no-op for already-offloaded
 * blocks (no `data`, nothing to write), and a re-read of the same image
 * hashes to the same content address: one physical file, and the log's new
 * reference points at it (`not a copy`).
 *
 * The offload events (`history.v2.offload{seq, blockIdx → artifactRef}`)
 * recording the physical offload are written by the durable provider that
 * applies this transform at its append boundary.
 *
 * @module
 */

import type { CanonicalHistoryEnvelope } from '../../sessions/representation/canonical-history-contract.js';
import type { ImageArtifactStore } from './image-artifact-store.js';

/** The reference block the canonical history stores instead of base64. */
export interface ImageArtifactReferenceBlock {
  readonly type: 'image';
  readonly mimeType: string;
  readonly sha256: string;
  /** Absolute artifact path — the model's read-again target. */
  readonly artifact: string;
  /** Decoded byte length (the stub's size line). */
  readonly bytes: number;
}

/** One image offloaded by {@link offloadMessageImages}. */
export interface ImageOffloadRecord {
  /** Index of the message (the future envelope) inside the transformed list. */
  readonly messageIndex: number;
  /** Index of the image block inside that message's content array. */
  readonly contentBlockIdx: number;
  readonly artifact: ImageArtifactReferenceBlock;
}

export interface OffloadMessageImagesResult {
  /** The SAME array instance when nothing was offloaded; a new one otherwise. */
  readonly messages: readonly unknown[];
  readonly offloads: readonly ImageOffloadRecord[];
}

/**
 * True when the content block is an inline image (base64 `data` present) —
 * the only shape this transform rewrites. Reference blocks and non-image
 * blocks pass through untouched.
 */
function isInlineImageBlock(block: unknown): block is { type: string; data: string; mimeType: string } {
  if (!block || typeof block !== 'object') return false;
  const record = block as Record<string, unknown>;
  return (
    record['type'] === 'image' &&
    typeof record['data'] === 'string' &&
    record['data'].length > 0 &&
    typeof record['mimeType'] === 'string'
  );
}

/**
 * Offloads every inline image block of the messages into the store and
 * replaces it with the artifact reference block. Generic over the message
 * shape (every caller's canonical message type is a structural record):
 * identity-stable — the transform runs BEFORE envelope identity is computed,
 * so the stored message, its message id and every later read-back agree on
 * the reference form.
 */
export function offloadMessageImages<TMessage>(
  messages: readonly TMessage[],
  store: ImageArtifactStore,
): OffloadMessageImagesResult & { readonly messages: readonly TMessage[] } {
  const offloads: ImageOffloadRecord[] = [];
  let mutated = false;
  const next: TMessage[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    const content: unknown =
      typeof message === 'object' && message !== null
        ? (message as { content?: unknown })['content']
        : undefined;
    if (!Array.isArray(content) || content.length === 0) {
      next.push(message);
      continue;
    }
    let messageMutated = false;
    const nextContent: unknown[] = content.map((block, contentBlockIdx) => {
      if (!isInlineImageBlock(block)) return block;
      const artifact = store.store({ data: block.data, mimeType: block.mimeType });
      const reference: ImageArtifactReferenceBlock = {
        type: 'image',
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        artifact: artifact.path,
        bytes: artifact.bytes,
      };
      offloads.push({ messageIndex, contentBlockIdx, artifact: reference });
      messageMutated = true;
      return reference;
    });
    next.push(
      messageMutated
        ? ({ ...(message as object), content: nextContent } as TMessage)
        : message,
    );
    if (messageMutated) mutated = true;
  }
  return { messages: mutated ? next : messages, offloads };
}

/**
 * Wave 2 (item 2.1): the reference block of an ALREADY-offloaded image, for
 * a receipt that arrives with no inline bytes of its own. `undefined` when
 * the block is not an image reference (callers skip it).
 */
export function readImageArtifactReference(block: unknown): ImageArtifactReferenceBlock | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const record = block as Record<string, unknown>;
  if (record['type'] !== 'image') return undefined;
  const sha256 = record['sha256'];
  const artifact = record['artifact'];
  if (typeof sha256 !== 'string' || typeof artifact !== 'string' || !artifact) return undefined;
  return {
    type: 'image',
    mimeType: typeof record['mimeType'] === 'string' ? record['mimeType'] : 'application/octet-stream',
    sha256,
    artifact,
    bytes: typeof record['bytes'] === 'number' ? record['bytes'] : 0,
  };
}

/**
 * The envelope positions of one offload pass: the durable provider maps each
 * offloaded message index onto the append entry's envelope list (1:1) and
 * writes one `offload` event per image with `(seq, blockIdx, contentBlockIdx,
 * artifactRef)`.
 */
export function offloadEventsOf(
  appendSeq: number,
  offloads: readonly ImageOffloadRecord[],
): {
  readonly seq: number;
  readonly blockIdx: number;
  readonly contentBlockIdx: number;
  readonly artifactRef: string;
}[] {
  return offloads.map((offload) => ({
    seq: appendSeq,
    blockIdx: offload.messageIndex,
    contentBlockIdx: offload.contentBlockIdx,
    artifactRef: offload.artifact.sha256,
  }));
}

/** Collects the reference blocks of one envelope's message (diagnostics/tests). */
export function imageReferencesOfEnvelope(envelope: CanonicalHistoryEnvelope): ImageArtifactReferenceBlock[] {
  const content = (envelope.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const references: ImageArtifactReferenceBlock[] = [];
  for (const block of content) {
    const reference = readImageArtifactReference(block);
    if (reference !== undefined) references.push(reference);
  }
  return references;
}
