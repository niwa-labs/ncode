/**
 * The daemon's event replay ring: a bounded, cursor-addressed window of recent
 * runtime events that late or reconnecting clients can replay.
 *
 * Limits follow the shape of the mcode SSE turn stream (`local-runtime`
 * `turn-stream.ts`): a frame cap and a UTF-8 byte cap, evicting oldest-first
 * in one pruning pass. The Ф4 contract pins this ring to 2000 frames / 8 MB
 * (the upstream turn stream currently runs 5000 frames / 8 MB — same byte
 * budget, larger window). Eviction is
 * the only way frames leave the ring before shutdown; once a cursor has been
 * evicted it is gone forever, and a replay anchored before it must fail
 * loudly (`replay_gap`) instead of silently skipping events.
 *
 * @module
 */

import { createLogger } from '@mavis/logging';

import type { Cursor } from './protocol.js';

/** Module-level logger for the `mcode:rpc` namespace (spec §9.3). */
const log = createLogger('mcode:rpc');

/** Replay window limits: frame count and total retained payload bytes. */
export interface ReplayLimits {
	/** Maximum number of retained frames; the oldest is evicted beyond it. */
	readonly maxFrames: number;
	/** Maximum total UTF-8 bytes of retained payloads; oldest-first eviction. */
	readonly maxBytes: number;
}

/**
 * Default limits, pinned by the Ф4 contract (2000 frames / 8 MB; the mcode
 * SSE turn stream shares the byte budget with a larger frame window).
 */
export const DEFAULT_REPLAY_LIMITS: ReplayLimits = {
	maxFrames: 2_000,
	maxBytes: 8 * 1024 * 1024,
};

/** One retained event: the opaque payload, its cursor and its measured size. */
export interface ReplayFrame {
	readonly cursor: Cursor;
	/** The runtime event payload, relayed verbatim on the wire. */
	readonly event: unknown;
	/** UTF-8 byte size of the serialized payload; the unit of `maxBytes`. */
	readonly bytes: number;
}

/** Result of a replay request anchored at a client cursor. */
export type ReplaySlice =
	| { ok: true; frames: ReplayFrame[] }
	| { ok: false; head: Cursor | null };

/** Bounded FIFO of event frames with cursor-addressed replay. */
export class ReplayRing {
	private readonly frames: ReplayFrame[] = [];
	private nextSeq = 1;
	private retainedBytes = 0;
	private evictedAny = false;
	private warnedEviction = false;
	/**
	 * Whether THIS life assigned its first cursor (`append`). `resumeFrom` and
	 * `seed` are restart-time operations and must both run before the first
	 * live append — in either order (seed the durable tail, then rebase the
	 * counter, or the reverse).
	 */
	private appendedInLife = false;
	private readonly retentionLimits: ReplayLimits;
	private readonly encoder = new TextEncoder();

	constructor(limits: ReplayLimits = DEFAULT_REPLAY_LIMITS) {
		if (!Number.isInteger(limits.maxFrames) || limits.maxFrames < 1) {
			throw new RangeError(`Invalid replay limit maxFrames ${limits.maxFrames}.`);
		}
		if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 1) {
			throw new RangeError(`Invalid replay limit maxBytes ${limits.maxBytes}.`);
		}
		this.retentionLimits = limits;
	}

	/** The retention contract this ring enforces (tail loads, pagination caps). */
	get limits(): ReplayLimits {
		return this.retentionLimits;
	}

	/**
	 * Rebase the cursor counter — the restart path. The hub calls this with
	 * the newest durable cursor (checkpoint watermark, or the seeded event
	 * tail when that is ahead) + 1, so cursors continue the daemon-wide
	 * sequence instead of restarting it. Valid only BEFORE the first live
	 * append of this life — a seeded ring (durable tail) still rebases fine.
	 */
	resumeFrom(startSeq: number): void {
		if (this.appendedInLife) {
			throw new Error('ReplayRing.resumeFrom is only valid before the first append');
		}
		if (!Number.isInteger(startSeq) || startSeq < 1) {
			throw new RangeError(`Invalid replay ring startSeq ${startSeq}.`);
		}
		this.nextSeq = startSeq;
	}

	/**
	 * Bulk-load retained frames — the durable-replay restart path. The hub
	 * calls this with the event log's tail BEFORE `resumeFrom`, so a
	 * reconnecting client replays across the restart instead of hitting
	 * `replay_gap`. Frames are trusted (they were produced by `append` of a
	 * previous life and re-measured on load); the window limits re-apply
	 * oldest-first, so an oversized log tail shrinks exactly like live
	 * eviction would. Valid only before the first live append of this life.
	 */
	seed(frames: readonly ReplayFrame[]): void {
		if (this.appendedInLife) {
			throw new Error('ReplayRing.seed is only valid before the first append');
		}
		for (const frame of frames) {
			this.frames.push(frame);
			this.retainedBytes += frame.bytes;
		}
		this.prune();
	}

	/**
	 * Append one event, assign its cursor, prune the window and return the
	 * retained frame. Oversized payloads are assigned a cursor and accepted
	 * (live delivery is the caller's job) but never retained: pruning removes
	 * them immediately, so replaying them is impossible by construction.
	 */
	append(event: unknown): ReplayFrame {
		const frame: ReplayFrame = {
			cursor: String(this.nextSeq++),
			event,
			bytes: this.encoder.encode(JSON.stringify(event)).byteLength,
		};
		this.appendedInLife = true;
		this.frames.push(frame);
		this.retainedBytes += frame.bytes;
		this.prune();
		return frame;
	}

	/** Newest retained cursor, or `null` while nothing has been appended. */
	get head(): Cursor | null {
		const last = this.frames[this.frames.length - 1];
		return last?.cursor ?? null;
	}

	/** Oldest retained cursor, or `null` while nothing is retained. */
	get oldest(): Cursor | null {
		return this.frames[0]?.cursor ?? null;
	}

	/** Whether pruning has dropped at least one frame so far. */
	get evicted(): boolean {
		return this.evictedAny;
	}

	/** Current occupancy against the limits. */
	size(): { frames: number; bytes: number } {
		return { frames: this.frames.length, bytes: this.retainedBytes };
	}

	/** Copy of the retained window, oldest first (durable-log compaction input). */
	framesSnapshot(): ReplayFrame[] {
		return [...this.frames];
	}

	/**
	 * Collect the retained frames strictly after `after`.
	 *
	 * - `after` omitted → the whole retained window (initial attach);
	 * - `after` === head → empty slice (client is current);
	 * - `after` unknown, evicted, or ahead of head → `{ ok: false }`: the
	 *   caller must surface a replay gap instead of guessing.
	 */
	replayAfter(after?: Cursor): ReplaySlice {
		if (after === undefined) {
			return { ok: true, frames: [...this.frames] };
		}
		const index = this.frames.findIndex((frame) => frame.cursor === after);
		if (index < 0) {
			return { ok: false, head: this.head };
		}
		return { ok: true, frames: this.frames.slice(index + 1) };
	}

	/** Evict oldest-first until both limits hold again. */
	private prune(): void {
		while (
			this.frames.length > this.retentionLimits.maxFrames ||
			this.retainedBytes > this.retentionLimits.maxBytes
		) {
			const dropped = this.frames.shift();
			if (!dropped) return;
			this.retainedBytes -= dropped.bytes;
			this.evictedAny = true;
			// Degradation signal once per ring lifetime (spec §5): from here on
			// clients anchored behind the window observe `replay_gap`.
			if (!this.warnedEviction) {
				this.warnedEviction = true;
				log.warn('replay-evict', { cursor: dropped.cursor, bytes: dropped.bytes });
			}
		}
	}
}
