/**
 * Wave 2 (canon 05 §2.5, item 2.1): the content-addressed IMAGE ARTIFACT
 * store — `<dataDir>/artifacts/<sha256>.<ext>`.
 *
 * The hash IS the name: one image, however many times it arrives (a read tool
 * result re-reading an artifact, the same attachment sent twice), hashes to
 * one file — the dedup is total, a re-offload never copies bytes. The
 * canonical history stores the REFERENCE block
 * (`{type:'image', mimeType, sha256, artifact, bytes}` — no `data`), so
 * base64 never reaches the log (the incident batch's 2.4 MB of inline media
 * class is gone at the source), and the bytes live once on disk. Artifacts
 * are removed only with their session, explicitly (the same rule as the log
 * itself); this module never deletes.
 *
 * Reads are synchronous and memoized by sha256: the residency rendering path
 * (`compileWindow`'s `renderImageBlock`) resolves a RESIDENT reference's
 * bytes back out of the store in one cache-hit read.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One stored image artifact (the reference block's source of truth). */
export interface ImageArtifact {
  /** sha256 over the base64 data — the content address and the file stem. */
  readonly sha256: string;
  /** File name `<sha256>.<ext>` — the artifact reference the log carries. */
  readonly fileName: string;
  /** Absolute artifact path (`<artifactsDir>/<fileName>`). */
  readonly path: string;
  readonly mimeType: string;
  /** Decoded byte length of the image (the stub's size line). */
  readonly bytes: number;
  /** True when THIS call wrote the file; false on a dedup hit. */
  readonly created: boolean;
}

export function resolveArtifactsDir(dataDir: string): string {
  return join(dataDir, 'artifacts');
}

/** Image extension for a mime type (`.bin` fallback keeps the file readable). */
export function imageArtifactExtension(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  const slash = normalized.indexOf('/');
  const subtype = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const clean = subtype.split(';')[0]?.trim() ?? '';
  return /^[a-z0-9]{1,12}$/.test(clean) ? `.${clean}` : '.bin';
}

/** Store options (test seam: an explicit dir; production resolves `<dataDir>/artifacts`). */
export interface ImageArtifactStoreOptions {
  readonly artifactsDir: string;
  /** Memoized read capacity. Default 64 — the resident window's worth. */
  readonly readMemoCapacity?: number;
}

/**
 * The content-addressed image artifact store of one runtime. Sync by design:
 * the durable append path offloads ONCE per unique image (the dedup makes the
 * steady state an existsSync), and the wire rendering resolves bytes on the
 * prepare path where async is not available.
 */
export class ImageArtifactStore {
  readonly artifactsDir: string;
  private readonly readMemo = new Map<string, string>();
  private readonly readMemoCapacity: number;
  private dirReady = false;

  constructor(options: ImageArtifactStoreOptions) {
    this.artifactsDir = options.artifactsDir;
    this.readMemoCapacity = options.readMemoCapacity ?? 64;
  }

  /**
   * Stores one image's bytes and returns the artifact reference. DEDUP: the
   * content address decides the file name, so storing the same image again
   * (a re-read, a repeated attachment) resolves to the SAME file and writes
   * nothing — the log's reference points at one physical copy.
   */
  store(input: { readonly data: string; readonly mimeType: string }): ImageArtifact {
    const sha256 = createHash('sha256').update(input.data, 'utf8').digest('hex');
    const fileName = `${sha256}${imageArtifactExtension(input.mimeType)}`;
    const path = join(this.artifactsDir, fileName);
    let created = false;
    if (!existsSync(path)) {
      this.ensureDir();
      // Write-then-rename is unnecessary for content-addressed names: a
      // concurrent write of the SAME content produces the same bytes.
      writeFileSync(path, Buffer.from(input.data, 'base64'));
      created = true;
    }
    const bytes = this.byteLength(path);
    return { sha256, fileName, path, mimeType: input.mimeType, bytes, created };
  }

  /**
   * Resolves an artifact's stored base64 by its content address (memoized).
   * `undefined` when the artifact does not exist (a foreign or purged sha).
   */
  readData(sha256: string): string | undefined {
    const memo = this.readMemo.get(sha256);
    if (memo !== undefined) return memo;
    const path = this.pathOf(sha256);
    if (path === undefined) return undefined;
    let data: string;
    try {
      data = readFileSync(path).toString('base64');
    } catch {
      return undefined;
    }
    this.writeMemo(sha256, data);
    return data;
  }

  /** Absolute path of the artifact file for a sha256, when it exists. */
  pathOf(sha256: string): string | undefined {
    if (!/^[0-9a-f]{64}$/i.test(sha256)) return undefined;
    const dir = this.ensureDir();
    for (const entry of listDirSafe(dir)) {
      if (entry.startsWith(sha256)) return join(dir, entry);
    }
    return undefined;
  }

  private ensureDir(): string {
    if (this.dirReady) return this.artifactsDir;
    mkdirSync(this.artifactsDir, { recursive: true });
    this.dirReady = true;
    return this.artifactsDir;
  }

  private byteLength(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private writeMemo(sha256: string, data: string): void {
    this.readMemo.delete(sha256);
    this.readMemo.set(sha256, data);
    while (this.readMemo.size > this.readMemoCapacity) {
      const oldest = this.readMemo.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.readMemo.delete(oldest);
    }
  }
}

function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
