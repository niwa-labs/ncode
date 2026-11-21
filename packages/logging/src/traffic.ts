import { appendFile } from 'node:fs/promises';
import { isSecretKey } from './env.js';
import { createLogger } from './logger.js';
import { isBase64Candidate, base64Stats, safeStringify } from './render.js';

/**
 * Traffic sink (spec §3): full LLM traffic goes to a file, one JSONL line per
 * `traffic(event, data)` call, buffered in memory, flushed in the background
 * every 100 ms or 1 MB. Without `MCODE_TRAFFIC_LOG` the sink is a no-op.
 * Enqueueing never throws and never blocks beyond building the line string.
 */

const FLUSH_INTERVAL_MS = 100;
const FLUSH_THRESHOLD_BYTES = 1024 * 1024;
/**
 * Hard queue cap. Past it events are dropped and counted; the counter is
 * reported as a `warn` at the next flush (spec §3). Chosen as a multiple of
 * the flush threshold so a single busy burst cannot grow the queue forever.
 */
const MAX_QUEUE_BYTES = 4 * FLUSH_THRESHOLD_BYTES;

const internalLog = createLogger('mcode:logging');

export interface TrafficSinkOptions {
  /** Target file; `undefined` makes the sink a no-op. */
  path: string | undefined;
  /** `MCODE_TRAFFIC_LOG_FULL=1`: keep base64 bodies verbatim. */
  full: boolean;
  flushIntervalMs?: number;
  flushThresholdBytes?: number;
  maxQueueBytes?: number;
}

export interface TrafficSink {
  enqueue(event: string, data: unknown): void;
  /** Writes all pending lines; resolves even when the sink is a no-op. */
  flush(): Promise<void>;
  pendingCount(): number;
  pendingBytes(): number;
  droppedCount(): number;
  /** Stops the flush timer and flushes once more. */
  dispose(): Promise<void>;
}

function sinkEnabled(path: string | undefined): path is string {
  return typeof path === 'string' && path.length > 0;
}

function unrefTimer(timer: NodeJS.Timeout): void {
  if (typeof timer.unref === 'function') timer.unref();
}

export function createTrafficSink(opts: TrafficSinkOptions): TrafficSink {
  const path = sinkEnabled(opts.path) ? opts.path : undefined;
  const full = opts.full;
  const flushThresholdBytes = opts.flushThresholdBytes ?? FLUSH_THRESHOLD_BYTES;
  const maxQueueBytes = opts.maxQueueBytes ?? MAX_QUEUE_BYTES;

  let pending: string[] = [];
  let queuedBytes = 0;
  let dropped = 0;
  let droppedSinceLastFlush = 0;
  let writing: Promise<void> = Promise.resolve();

  // Secrets are removed always, including FULL mode (spec §3/§8); base64
  // bodies are redacted unless FULL (spec §3).
  const stringifyOptions = {
    filterSecrets: true,
    transformString: (s: string): unknown =>
      !full && isBase64Candidate(s) ? { redactedBase64: base64Stats(s) } : s,
  };

  function buildLine(event: string, data: unknown): string {
    const line = safeStringify(
      { ts: new Date().toISOString(), event, data },
      stringifyOptions,
    );
    return `${line}\n`;
  }

  async function writeBatch(batch: string[]): Promise<void> {
    const previous = writing;
    writing = previous
      .then(() => appendFile(path as string, batch.join(''), 'utf8'))
      .catch(() => {
        // Sink write failures are silent (spec §1: never throws, never blocks).
      });
    await writing;
  }

  async function flush(): Promise<void> {
    if (path === undefined) return;
    if (droppedSinceLastFlush > 0) {
      internalLog.warn('traffic queue overflow: events dropped', { dropped: droppedSinceLastFlush });
      droppedSinceLastFlush = 0;
    }
    if (pending.length === 0) {
      // Nothing new: still wait out an in-flight background write so callers
      // can rely on flush() for durable delivery.
      await writing;
      return;
    }
    const batch = pending;
    pending = [];
    queuedBytes = 0;
    await writeBatch(batch);
  }

  const timer =
    path !== undefined
      ? setInterval(() => {
          void flush().catch(() => {});
        }, opts.flushIntervalMs ?? FLUSH_INTERVAL_MS)
      : null;
  if (timer !== null) unrefTimer(timer);

  return {
    enqueue(event, data) {
      if (path === undefined) return;
      let line: string;
      try {
        line = buildLine(event, data);
      } catch {
        return; // never throws
      }
      const lineBytes = Buffer.byteLength(line, 'utf8');
      // Overflow: an already non-empty queue past the cap drops new events.
      // A single oversized line is still admitted so the queue cannot wedge.
      if (queuedBytes > 0 && queuedBytes + lineBytes > maxQueueBytes) {
        dropped += 1;
        droppedSinceLastFlush += 1;
        return;
      }
      pending.push(line);
      queuedBytes += lineBytes;
      if (queuedBytes >= flushThresholdBytes) void flush().catch(() => {});
    },
    flush,
    pendingCount: () => pending.length,
    pendingBytes: () => queuedBytes,
    droppedCount: () => dropped,
    async dispose() {
      if (timer !== null) clearInterval(timer);
      await flush();
    },
  };
}

function createSinkFromEnv(env: Record<string, string | undefined>): TrafficSink {
  const rawPath = env.MCODE_TRAFFIC_LOG;
  const path = typeof rawPath === 'string' && rawPath.trim().length > 0 ? rawPath : undefined;
  return createTrafficSink({ path, full: env.MCODE_TRAFFIC_LOG_FULL === '1' });
}

// Without MCODE_TRAFFIC_LOG the singleton is a no-op (spec §2).
let activeSink: TrafficSink = createSinkFromEnv(process.env);

/** Полный трафик (§3): пишется в файл, а не в stderr. */
export function traffic(event: string, data: unknown): void {
  try {
    activeSink.enqueue(event, data);
  } catch {
    // never throws (spec §3)
  }
}

/** Test seam: reinitializes the module sink as if the process had this env. */
export function _initTrafficForTests(env: Record<string, string | undefined>): void {
  const previous = activeSink;
  activeSink = createSinkFromEnv(env);
  void previous.dispose().catch(() => {});
}

/** Test seam: the current module sink (for direct flush/drop assertions). */
export function _activeTrafficSinkForTests(): TrafficSink {
  return activeSink;
}
