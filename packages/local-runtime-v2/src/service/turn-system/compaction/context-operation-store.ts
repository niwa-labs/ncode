import { createLogger } from '@mavis/logging';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceFileAtomically } from '../../../infra/file/jsonl.js';
import type {
  ReadyCompaction,
  ReadyCompactionStore,
} from '@mavis/context-compaction';

const log = createLogger('mcode:context-operations');

export type RequestPhase =
  | 'prepared'
  | 'dispatch_intent'
  | 'response_received'
  | 'response_committed'
  | 'failed'
  | 'aborted'
  | 'unknown'
  | 'not_sent';
export interface RequestReceipt {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly kind: 'agent' | 'compaction';
  readonly model: string;
  readonly planDigest: string;
  phase: RequestPhase;
  responseDigest?: string;
  readonly events: {
    phase: RequestPhase;
    atMs: number;
    payloadDigest?: string;
    responseDigest?: string;
    stopReason?: string;
    usage?: unknown;
  }[];
}
export function contextDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'null')
    .digest('hex');
}
export function responseDigest(message: unknown): string {
  if (!message || typeof message !== 'object') return contextDigest(message);
  return contextDigest({
    content: Reflect.get(message, 'content'),
    timestamp: Reflect.get(message, 'timestamp'),
  });
}

/** Local daemon-owned control artifacts. Atomic fsynced files, no prompt copies. */
export class ContextOperationStore {
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, Map<string, RequestReceipt>>();
  private readonly recovery = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  private root(sessionId: string): string {
    return join(this.directory, contextDigest(sessionId));
  }
  private receiptPath(receipt: RequestReceipt): string {
    return join(this.root(receipt.sessionId), 'requests', `${receipt.id}.json`);
  }
  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.lanes.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.lanes.set(sessionId, next);
    void next
      .finally(() => {
        if (this.lanes.get(sessionId) === next) this.lanes.delete(sessionId);
      })
      .catch(() => undefined);
    return next;
  }
  private async save(receipt: RequestReceipt): Promise<void> {
    await replaceFileAtomically(
      this.receiptPath(receipt),
      JSON.stringify(receipt),
    );
  }
  private async readReadyEnvelope(sessionId: string): Promise<
    | {
        version: 1;
        digest: string;
        value: ReadyCompaction;
        requestIds: string[];
      }
    | undefined
  > {
    const path = join(this.root(sessionId), 'ready.json');
    try {
      if ((await stat(path)).size > 32 * 1024 * 1024)
        throw new Error('Ready compaction artifact exceeds its bound');
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (
        data.version !== 1 ||
        contextDigest(data.value) !== data.digest ||
        !Array.isArray(data.value?.source) ||
        !data.value?.outcome?.draft ||
        !Array.isArray(data.requestIds)
      )
        throw new Error('Invalid ready compaction artifact');
      return data;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      // A corrupt optional optimization must not prevent ordinary requests.
      // I/O/permission failures remain explicit; no source journal is touched.
      if (!code) {
        await rm(path, { force: true });
        return undefined;
      }
      throw error;
    }
  }

  /** Run once per owner process, before its first dispatch; never reclassify live work. */
  recover(sessionId: string, messages: readonly unknown[]): Promise<void> {
    const existing = this.recovery.get(sessionId);
    if (existing) return existing;
    const job = this.serial(sessionId, async () => {
      const committed = new Set(
        messages
          .filter(
            (m) =>
              m &&
              typeof m === 'object' &&
              Reflect.get(m, 'role') === 'assistant',
          )
          .map(responseDigest),
      );
      const committedRequests = new Set(
        messages.flatMap((m) =>
          m &&
          typeof m === 'object' &&
          Reflect.get(m, 'role') === 'assistant' &&
          typeof Reflect.get(m, 'requestReceiptId') === 'string'
            ? [Reflect.get(m, 'requestReceiptId')]
            : [],
        ),
      );
      const committedSummaries = new Set<string>(
        messages.flatMap((m) =>
          m &&
          typeof m === 'object' &&
          Array.isArray(Reflect.get(m, 'summaryRequestIds'))
            ? Reflect.get(m, 'summaryRequestIds')
            : [],
        ),
      );
      const ready = await this.readReadyEnvelope(sessionId);
      ready?.requestIds.forEach((id) => committedSummaries.add(id));
      let names: string[];
      try {
        names = await readdir(join(this.root(sessionId), 'requests'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return;
      }
      for (const name of names) {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
        const receipt = JSON.parse(
          await readFile(join(this.root(sessionId), 'requests', name), 'utf8'),
        ) as RequestReceipt;
        if (
          receipt.version !== 1 ||
          receipt.sessionId !== sessionId ||
          !Array.isArray(receipt.events)
        )
          throw new Error('Invalid request receipt');
        if (
          !['prepared', 'dispatch_intent', 'response_received'].includes(
            receipt.phase,
          )
        )
          continue;
        const phase: RequestPhase =
          receipt.phase === 'prepared'
            ? 'not_sent'
            : committedRequests.has(receipt.id) ||
                (receipt.responseDigest &&
                  committed.has(receipt.responseDigest)) ||
                committedSummaries.has(receipt.id)
              ? 'response_committed'
              : 'unknown';
        receipt.phase = phase;
        receipt.events.push({ phase, atMs: Date.now() });
        await this.save(receipt);
      }
    });
    this.recovery.set(sessionId, job);
    return job;
  }

  async begin(
    input: Omit<RequestReceipt, 'version' | 'id' | 'phase' | 'events'>,
  ): Promise<RequestReceipt> {
    await this.recovery.get(input.sessionId);
    return this.serial(input.sessionId, async () => {
      const receipt: RequestReceipt = {
        ...input,
        version: 1,
        id: randomUUID(),
        phase: 'prepared',
        events: [{ phase: 'prepared', atMs: Date.now() }],
      };
      await this.save(receipt);
      let pending = this.pending.get(input.sessionId);
      if (!pending) this.pending.set(input.sessionId, (pending = new Map()));
      pending.set(receipt.id, receipt);
      return receipt;
    });
  }
  record(
    receipt: RequestReceipt,
    phase: RequestPhase,
    details: Omit<RequestReceipt['events'][number], 'phase' | 'atMs'> = {},
  ): Promise<void> {
    return this.serial(receipt.sessionId, async () => {
      if (receipt.phase === 'response_committed') return;
      receipt.phase = phase;
      if (details.responseDigest)
        receipt.responseDigest = details.responseDigest;
      receipt.events.push({ phase, atMs: Date.now(), ...details });
      await this.save(receipt);
      if (
        [
          'response_committed',
          'failed',
          'aborted',
          'unknown',
          'not_sent',
        ].includes(phase)
      )
        this.pending.get(receipt.sessionId)?.delete(receipt.id);
    });
  }
  summaryRequestIds(sessionId: string): string[] {
    return [...(this.pending.get(sessionId)?.values() ?? [])]
      .filter((r) => r.kind === 'compaction' && r.phase === 'response_received')
      .map((r) => r.id);
  }
  private async confirmCommitted(receipt: RequestReceipt): Promise<void> {
    // The canonical answer/READY file is already durable. A receipt projection
    // failure cannot undo that commit or cause another paid request.
    try {
      await this.record(receipt, 'response_committed');
    } catch {
      this.pending.get(receipt.sessionId)?.delete(receipt.id);
      log.warn('committed response receipt needs recovery', {
        session_id: receipt.sessionId,
        request_id: receipt.id,
      });
    }
  }
  async commitResponses(
    sessionId: string,
    messages: readonly unknown[],
  ): Promise<void> {
    const ids = new Set(
      messages.flatMap((m) =>
        m && typeof m === 'object' && Reflect.get(m, 'role') === 'assistant'
          ? [Reflect.get(m, 'requestReceiptId')]
          : [],
      ),
    );
    const hashes = new Set(
      messages
        .filter(
          (m) =>
            m &&
            typeof m === 'object' &&
            Reflect.get(m, 'role') === 'assistant',
        )
        .map(responseDigest),
    );
    for (const receipt of [...(this.pending.get(sessionId)?.values() ?? [])]) {
      if (
        receipt.kind === 'agent' &&
        (ids.has(receipt.id) ||
          (receipt.responseDigest && hashes.has(receipt.responseDigest)))
      )
        await this.confirmCommitted(receipt);
    }
  }
  async commitSummaries(sessionId: string): Promise<void> {
    for (const receipt of [...(this.pending.get(sessionId)?.values() ?? [])]) {
      if (
        receipt.kind === 'compaction' &&
        receipt.phase === 'response_received'
      )
        await this.confirmCommitted(receipt);
    }
  }
  readyStore(sessionId: string): ReadyCompactionStore {
    return {
      load: async () => (await this.readReadyEnvelope(sessionId))?.value,
      beginPreparation: async () => {
        // A new attempt cannot claim an older rejected summary as committed.
        for (const receipt of [
          ...(this.pending.get(sessionId)?.values() ?? []),
        ]) {
          if (
            receipt.kind === 'compaction' &&
            receipt.phase === 'response_received'
          ) {
            await this.record(receipt, 'unknown');
          }
        }
      },
      save: async (value) => {
        const requestIds = this.summaryRequestIds(sessionId);
        const stored = { ...value, requestIds };
        await this.serial(sessionId, async () => {
          const envelope = {
            version: 1,
            digest: contextDigest(stored),
            value: stored,
            requestIds,
          };
          const serialized = JSON.stringify(envelope);
          if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
            throw new Error('Ready compaction artifact exceeds its bound');
          await replaceFileAtomically(
            join(this.root(sessionId), 'ready.json'),
            serialized,
          );
        });
        await this.commitSummaries(sessionId);
        return stored;
      },
      clear: async () => {
        await this.serial(sessionId, () =>
          rm(join(this.root(sessionId), 'ready.json'), { force: true }),
        );
      },
    };
  }
}
