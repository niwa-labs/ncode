/**
 * The daemon's durable event log: the replay window that survives a restart.
 *
 * The Ф4 skeleton kept replay in memory only (README, "Not in this wave:
 * durable event history for post-restart replay") and answered every
 * pre-restart cursor with `replay_gap`. The product semantics the W10 plan
 * pins — "durable-backed session operations", replay instead of a silent
 * gap — append every retained frame here, and `McodedHub.start` seeds the
 * ring from the durable tail. A client that reconnects to a RESTARTED daemon
 * with `after: K` replays exactly like a client that never lost the
 * connection, for as long as K is inside the bounded window; older cursors
 * still answer `replay_gap` (the window stays bounded by the `ReplayLimits`
 * contract — the plan's "no eager full get_entries").
 *
 * The shape is a single append-only JSONL file under the durable root, one
 * `{"cursor":…,"event":…}` document per line:
 * - one daemon per durable root owns the file (the daemon lifecycle already
 *   enforces that), so no cross-process locking is needed;
 * - appends are coalesced behind one writer promise — the event pump never
 *   waits on disk, mirroring the checkpoint writer discipline in
 *   `checkpoint.ts`;
 * - `loadTail` reads the file back-to-front in bounded chunks and TOLERATES a
 *   torn final line: a crash mid-write leaves a partial line, which reads as
 *   "that frame was never durably acknowledged" — cursor continuity comes
 *   from the checkpoint and the seeded cursors themselves, never from
 *   re-reading that line;
 * - when the file crosses `maxFileBytes`, the next append first compacts it
 *   to the retention window (the same `ReplayLimits` a fresh daemon would
 *   seed), so a long-lived daemon never writes without bound; `compact` is
 *   atomic (temp sibling + rename).
 *
 * @module
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '@mavis/logging';

import { DEFAULT_REPLAY_LIMITS, type ReplayFrame, type ReplayLimits } from './replay-ring.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** File name of the default event log inside the durable root. */
export const MCODED_EVENT_LOG_BASENAME = 'mcoded-events.jsonl';

/** Size cap of the log file before the next append rotates it. Default 32 MiB. */
export const DEFAULT_EVENT_LOG_MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Reverse-read chunk of one `loadTail` pass. */
const TAIL_CHUNK_BYTES = 1024 * 1024;

/** Durability seam the hub drives; {@link FileEventLog} is the product shape. */
export interface EventLog {
	/** Append one retained frame. Resolves when the line is handed to the OS. */
	append(frame: ReplayFrame): Promise<void>;
	/**
	 * Load the most recent frames worth retaining, oldest first. Implementations
	 * read a bounded tail (never the whole history) and silently drop a torn
	 * final line.
	 */
	loadTail(limits: ReplayLimits): Promise<ReplayFrame[]>;
	/** Rewrite the log with exactly `frames` (atomic publish). */
	compact(frames: readonly ReplayFrame[]): Promise<void>;
	/** Await the coalesced writer so shutdown/tests can pin durability. */
	flush(): Promise<void>;
}

/** Options of {@link FileEventLog}. */
export interface FileEventLogOptions {
	/** Retention contract the tail load and the rotation compact honor. */
	readonly limits?: ReplayLimits;
	/** Grow cap of the log file; see the module doc. Default 32 MiB. */
	readonly maxFileBytes?: number;
}

/**
 * Append-only JSONL event log with atomic compaction. The product
 * {@link EventLog} for the daemon root.
 */
export class FileEventLog implements EventLog {
	private readonly filePath: string;
	private readonly tempPath: string;
	private readonly limits: ReplayLimits;
	private readonly maxFileBytes: number;
	private writeQueue: Promise<void> = Promise.resolve();
	private fileBytes: number | undefined;

	constructor(filePath: string, options: FileEventLogOptions = {}) {
		this.filePath = filePath;
		this.tempPath = `${filePath}.tmp`;
		this.limits = options.limits ?? DEFAULT_REPLAY_LIMITS;
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_EVENT_LOG_MAX_FILE_BYTES;
	}

	async append(frame: ReplayFrame): Promise<void> {
		const run = this.writeQueue.then(() => this.appendOnce(frame));
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async loadTail(limits: ReplayLimits): Promise<ReplayFrame[]> {
		const lines = await this.readTailLines(limits);
		const frames: ReplayFrame[] = [];
		let bytes = 0;
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index];
			if (line === undefined || line.length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// A corrupt interior line (platform-level partial write) is skipped,
				// never fatal: replay is a best-effort window, not a source of truth.
				log.warn('event-log-line-skipped', { byteLength: line.length });
				continue;
			}
			const frame = decodeFrame(parsed);
			if (!frame) continue;
			bytes += frame.bytes;
			frames.unshift(frame);
			if (frames.length >= limits.maxFrames || bytes >= limits.maxBytes) break;
		}
		return frames;
	}

	async compact(frames: readonly ReplayFrame[]): Promise<void> {
		const run = this.writeQueue.then(() => this.compactOnce(frames));
		this.writeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	private async appendOnce(frame: ReplayFrame): Promise<void> {
		const line = serializeFrame(frame);
		if (this.fileBytes === undefined) {
			this.fileBytes = await fileSizeOrZero(this.filePath);
		}
		if (this.fileBytes > 0 && this.fileBytes + line.length + 1 > this.maxFileBytes) {
			// Grow cap reached: rotate to the retention window first (the same
			// frames a fresh daemon would seed), then append the new line. The
			// single write queue serializes both steps.
			const tail = await this.loadTail(this.limits);
			await this.compactOnce(tail);
		}
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await fs.appendFile(this.filePath, `${line}\n`, 'utf8');
		this.fileBytes += Buffer.byteLength(line, 'utf8') + 1;
	}

	private async compactOnce(frames: readonly ReplayFrame[]): Promise<void> {
		const payload =
			frames.length === 0
				? ''
				: `${frames.map((frame) => serializeFrame(frame)).join('\n')}\n`;
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await fs.writeFile(this.tempPath, payload, 'utf8');
		await fs.rename(this.tempPath, this.filePath);
		this.fileBytes = Buffer.byteLength(payload, 'utf8');
	}

	/**
	 * Read the file back-to-front in bounded chunks until the retention window
	 * can be decided: enough frames, enough bytes, or the file start. Only the
	 * FINAL line of the file may be torn (crash mid-append); interior corrupt
	 * lines are skipped by `loadTail`.
	 */
	private async readTailLines(limits: ReplayLimits): Promise<string[]> {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(this.filePath, 'r');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		try {
			const { size } = await handle.stat();
			if (size === 0) return [];
			const collected: string[] = [];
			let bytesSeen = 0;
			let carry = '';
			let position = size;
			let atFileTail = true;
			while (position > 0) {
				const chunkBytes = Math.min(TAIL_CHUNK_BYTES, position);
				position -= chunkBytes;
				const chunk = Buffer.alloc(chunkBytes);
				await handle.read(chunk, 0, chunkBytes, position);
				bytesSeen += chunkBytes;
				const text = chunk.toString('utf8') + carry;
				const lines = text.split('\n');
				if (atFileTail) {
					// The fragment after the file's final newline is a torn write
					// (a complete log always ends with one) — drop it.
					lines.pop();
					atFileTail = false;
				} else {
					// The chunk boundary splits a line in half; the head fragment
					// belongs to the next (older) chunk.
					carry = lines.shift() ?? '';
				}
				collected.unshift(...lines);
				if (collected.length > limits.maxFrames || bytesSeen >= limits.maxBytes * 2) break;
			}
			if (carry.length > 0 && position <= 0) collected.unshift(carry);
			return collected;
		} finally {
			await handle.close();
		}
	}
}

/** One JSONL line of the log: the frame the hub retained. */
function serializeFrame(frame: ReplayFrame): string {
	return JSON.stringify({ cursor: frame.cursor, event: frame.event });
}

/** Decode one parsed log line back into a replay frame, or `undefined`. */
function decodeFrame(value: unknown): ReplayFrame | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as { cursor?: unknown; event?: unknown };
	if (typeof record.cursor !== 'string' || record.cursor.length === 0) return undefined;
	const seq = Number(record.cursor);
	if (!Number.isInteger(seq) || seq < 1) return undefined;
	if (record.event === undefined) return undefined;
	return {
		cursor: record.cursor,
		event: record.event,
		bytes: Buffer.byteLength(JSON.stringify(record.event), 'utf8'),
	};
}

async function fileSizeOrZero(filePath: string): Promise<number> {
	try {
		const stat = await fs.stat(filePath);
		return stat.size;
	} catch {
		return 0;
	}
}
