/**
 * MCODE_TUI_TRACE sidecar: time-stamped frame-boundary trace of terminal output.
 *
 * `MCODE_TUI_TRACE=<path>` opts in; without the variable nothing is created and
 * the hot path only pays one `undefined` check per write. The sidecar is a
 * JSONL file where each line is one record:
 *
 *   {"ts":<wall ms>,"monoNs":"<hrtime ns>","seq":<n>,"frameNo":<n>,"bytes":<n>,"kind":"..."}
 *
 * - `ts` — `Date.now()` wall clock at the moment the record was produced (ms).
 * - `monoNs` — `process.hrtime.bigint()` as a decimal string (JSON cannot hold
 *   64-bit integers); pair it with `ts` for clock calibration (§7.1 of the
 *   video-test architecture).
 * - `seq` — monotonic record counter for this file; a gap without a matching
 *   `drop` record means the reader missed nothing (records are only dropped
 *   with a counter, never silently).
 * - `frameNo` — 1-based frame counter; `0` marks records outside any frame.
 * - `bytes` — UTF-8 bytes written to the terminal for this write/frame, or the
 *   dropped-record count for `kind:"drop"`.
 * - `kind`:
 *   - `open`  — single first record, emitted when tracing starts.
 *   - `frame.begin` / `frame.end` — the render-frame boundaries driven by
 *     `TuiBase.renderFrame()` through `Terminal.traceFrameBegin/End`.
 *     `frame.end.bytes` is the total bytes written while the frame was open,
 *     which is the unit an analyzer joins against synchronized-output groups
 *     (`?2026h/l`) in the raw `PI_TUI_WRITE_LOG` stream.
 *   - `write` — a terminal write outside any frame (startup controls, cursor
 *     queries, progress keepalives). `frameNo` is the last begun frame.
 *   - `drop`  — the bounded queue overflowed; `bytes` is how many records were
 *     dropped since the previous flush. Overflow never blocks or throws on the
 *     render path.
 *   - `close` — single final record, emitted when the tracer is closed.
 *
 * Writes are buffered in memory and flushed to the file by a bounded async
 * sink (interval flush, 4 MiB queue budget) — there is deliberately no
 * synchronous fs call per frame (hot-path hygiene, §7 of the logging spec).
 * Readers should treat `ts` ordering as authoritative only together with
 * `seq`, because a flush batch is written as one blob after an async gap.
 */

import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "@mavis/logging";

const log = createLogger("mcode:tui");

export type TuiTraceKind = "open" | "frame.begin" | "frame.end" | "write" | "drop" | "close";

/** One JSONL line of the sidecar; the exact reader contract lives in the header comment. */
export interface TuiTraceRecord {
	readonly ts: number;
	readonly monoNs: string;
	readonly seq: number;
	readonly frameNo: number;
	readonly bytes: number;
	readonly kind: TuiTraceKind;
}

export interface TuiFrameTracerOptions {
	readonly path: string;
	/** Maximum in-memory queue size in bytes before records are dropped. */
	readonly maxQueueBytes?: number;
	/** How often queued records are written to disk. */
	readonly flushIntervalMs?: number;
	readonly now?: () => number;
	readonly monoNs?: () => string;
}

const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 100;

export class TuiFrameTracer {
	private seq = 0;
	private frameNo = 0;
	private frameBytes = 0;
	private inFrame = false;
	private closed = false;
	private queue: string[] = [];
	private queuedBytes = 0;
	private droppedSinceFlush = 0;
	private flushTimer: NodeJS.Timeout | undefined;
	private handle: FileHandle | undefined;
	private opening: Promise<FileHandle> | undefined;
	private writeChain = Promise.resolve();
	private writeFailureReported = false;
	private readonly maxQueueBytes: number;
	private readonly flushIntervalMs: number;
	private readonly now: () => number;
	private readonly monoNs: () => string;
	private readonly tracePath: string;

	constructor(options: TuiFrameTracerOptions) {
		this.tracePath = options.path;
		this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.now = options.now ?? Date.now;
		this.monoNs = options.monoNs ?? (() => process.hrtime.bigint().toString());
		this.appendRecord("open", 0, 0);
	}

	get path(): string {
		return this.tracePath;
	}

	/** Mark the start of a render frame; subsequent writes count toward it. */
	beginFrame(): void {
		if (this.closed || this.inFrame) return;
		this.frameNo += 1;
		this.inFrame = true;
		this.frameBytes = 0;
		this.appendRecord("frame.begin", this.frameNo, 0);
	}

	/** Close the open frame and record the bytes written while it was open. */
	endFrame(): void {
		if (this.closed || !this.inFrame) return;
		this.inFrame = false;
		this.appendRecord("frame.end", this.frameNo, this.frameBytes);
		this.frameBytes = 0;
	}

	/** Account one terminal write; inside a frame it accumulates, outside it records. */
	onWrite(bytes: number): void {
		if (this.closed) return;
		if (this.inFrame) {
			this.frameBytes += bytes;
			return;
		}
		this.appendRecord("write", this.frameNo, bytes);
	}

	/** Write everything queued so far; resolves after the file caught up. */
	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.enqueueBatch(this.takeQueue());
		await this.writeChain;
	}

	/** Append the final `close` record, flush, and release the file handle. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// Persist what preceded the close under the normal budget rules first,
		// so the `close` record itself is appended to an empty queue: readers
		// poll for it as the end-of-stream marker (a trace that ends on a
		// `write` looks truncated), so it must never fall to the budget.
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.enqueueBatch(this.takeQueue());
		this.appendRecord("close", this.frameNo, 0);
		await this.flush();
		const handle = this.handle;
		this.handle = undefined;
		this.opening = undefined;
		await this.writeChain.catch(() => undefined);
		await handle?.close().catch(() => undefined);
	}

	private appendRecord(kind: TuiTraceKind, frameNo: number, bytes: number): void {
		const record = `${JSON.stringify({
			ts: this.now(),
			monoNs: this.monoNs(),
			seq: ++this.seq,
			frameNo,
			bytes,
			kind,
		})}\n`;
		if (this.queuedBytes + record.length > this.maxQueueBytes) {
			this.droppedSinceFlush += 1;
			this.scheduleFlush();
			return;
		}
		this.queue.push(record);
		this.queuedBytes += record.length;
		this.scheduleFlush();
	}

	private takeQueue(): string[] {
		const batch = this.queue;
		this.queue = [];
		this.queuedBytes = 0;
		if (this.droppedSinceFlush > 0) {
			// Surface the gap explicitly so a reader can invalidate the run
			// (INVALID_TELEMETRY) instead of silently joining a partial stream.
			const dropped = this.droppedSinceFlush;
			this.droppedSinceFlush = 0;
			log.warn("trace.drop", { dropped });
			batch.unshift(
				`${JSON.stringify({
					ts: this.now(),
					monoNs: this.monoNs(),
					seq: ++this.seq,
					frameNo: 0,
					bytes: dropped,
					kind: "drop",
				})}\n`,
			);
		}
		return batch;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.enqueueBatch(this.takeQueue());
		}, this.flushIntervalMs);
		this.flushTimer.unref?.();
	}

	private enqueueBatch(batch: string[]): void {
		if (batch.length === 0) return;
		this.writeChain = this.writeChain
			.then(() => this.ensureHandle())
			// The write is awaited inside the chain: an un-awaited
			// `handle.write` would let the next batch's write race this one on
			// the threadpool (O_APPEND preserves data, not order), so records
			// could land out of order and `close()` could close the handle
			// mid-write. Awaiting keeps batches strictly in queue order.
			.then(async (handle) => {
				await handle.write(batch.join(""));
			})
			.catch((error: unknown) => {
				// Reopen on the next batch; report the failure once per streak so a
				// broken path cannot flood the log on the render path.
				this.handle = undefined;
				this.opening = undefined;
				if (!this.writeFailureReported) {
					this.writeFailureReported = true;
					log.warn("trace.writeFailed", { err: error });
				}
			});
	}

	private ensureHandle(): Promise<FileHandle> {
		if (this.handle) return Promise.resolve(this.handle);
		this.opening ??= (async () => {
			await mkdir(dirname(this.tracePath), { recursive: true });
			const handle = await open(this.tracePath, "a", 0o600);
			this.handle = handle;
			this.writeFailureReported = false;
			return handle;
		})();
		return this.opening;
	}
}

/**
 * Create the sidecar tracer for `MCODE_TUI_TRACE=<path>`, or `undefined` when
 * the variable is unset/blank. The path is created lazily on the first flush.
 */
export function createTuiFrameTracerFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): TuiFrameTracer | undefined {
	const tracePath = env.MCODE_TUI_TRACE?.trim();
	if (!tracePath) return undefined;
	return new TuiFrameTracer({ path: tracePath });
}
