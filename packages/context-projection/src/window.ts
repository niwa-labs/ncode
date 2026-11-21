// Persistent chunked window list + the projection's perf counters.
//
// The honest complexity contract (port-plan §2.7, "Append и обновление fold")
// forbids copying the W-sized window array on every entry: the fold update
// must be O(Δ + touched pages). `ChunkedView` is the persistent structure that
// delivers it — an immutable list of fixed-capacity chunks where `append`
// copies only the tail chunk (≤ {@link WINDOW_CHUNK_CAPACITY} refs) and, once
// per full chunk, the chunk-pointer array (W/CAPACITY refs amortized to O(1)
// per append). Control rewrites (edits, compaction cuts) rebuild the view from
// a materialized array — their explicitly paid O(W) invalidation, which the
// counters make observable.
//
// The counters are TEST INSTRUMENTATION for the wave's G-PERF/I03 gate
// (counter assertions, plan §7): they add two integer increments to the hot
// path and never influence behavior. `windowRefsCopied` counts window member
// references copied on the projection's write paths — appends, control
// rewrites (edits, compaction cuts) AND window materializations (`toArray`):
// a W-proportional copy anywhere on those paths must show up here, or the
// gate is blind to it (the W03 review's finding №1 — `toArray` used to be
// "not counted" while `toManifest` materialized the whole window per commit).
// `payloadBytesMeasured` counts payload byte-length computations (the
// decode/measure work the no-op gate requires to be zero for old payloads).
// The SAME-HEAD read path (the revision-cached manifest, `revision()`,
// `capsule()`, a `snapshot()` over the cached manifest) copies ZERO refs —
// that is exactly what the same-head counter assertions pin.

/** Capacity of one chunk; the per-append copy bound. */
export const WINDOW_CHUNK_CAPACITY = 64;

/** Perf counters of the projection fold (test instrumentation; see module doc). */
export interface ProjectionPerfCounters {
	/**
	 * Window member references copied on the projection's write paths:
	 * appends copy ≤ {@link WINDOW_CHUNK_CAPACITY} + amortized pointer refs
	 * per entry, control rewrites pay O(W) by design, and every window
	 * materialization (`toArray` — a manifest build, an `llmSegments` read)
	 * counts its full size. Same-head cached reads copy zero.
	 */
	windowRefsCopied: number;
	/** Payload byte-length computations performed (per new payload / replacement). */
	payloadBytesMeasured: number;
}

/** The projection's live perf counters. Read/reset by the G-PERF tests. */
export const projectionPerf: ProjectionPerfCounters = {
	windowRefsCopied: 0,
	payloadBytesMeasured: 0,
};

/** Zeroes {@link projectionPerf} (call from tests before a measured section). */
export function resetProjectionPerf(): void {
	projectionPerf.windowRefsCopied = 0;
	projectionPerf.payloadBytesMeasured = 0;
}

/**
 * An immutable, chunked, append-optimized list — the persistent window
 * structure of the projection fold. All methods are non-mutating; structural
 * sharing keeps old states valid (a fold state is never invalidated by later
 * folds of the same log prefix).
 */
export class ChunkedView<T> {
	private constructor(
		/** Full, immutable chunks of exactly {@link WINDOW_CHUNK_CAPACITY} items. */
		private readonly chunks: readonly (readonly T[])[],
		/** The open tail chunk: 0..CAPACITY items, copied on every append. */
		private readonly tail: readonly T[],
		/** Total item count. */
		readonly size: number,
	) {}

	/** The empty view. */
	static empty<T>(): ChunkedView<T> {
		return new ChunkedView<T>([], [], 0);
	}

	/** Builds a view over `items` (O(n); the paid cost of a control rewrite). */
	static from<T>(items: readonly T[]): ChunkedView<T> {
		projectionPerf.windowRefsCopied += items.length;
		const chunks: (readonly T[])[] = [];
		for (let start = 0; start < items.length; start += WINDOW_CHUNK_CAPACITY) {
			chunks.push(items.slice(start, start + WINDOW_CHUNK_CAPACITY));
		}
		const tail = chunks.pop() ?? [];
		return new ChunkedView(chunks, tail, items.length);
	}

	/**
	 * Appends one item: copies the tail chunk (≤ CAPACITY refs) and, when the
	 * tail is full, publishes it and copies the chunk-pointer array
	 * (size/CAPACITY refs once per CAPACITY appends — amortized O(1)). Never
	 * copies the whole window.
	 */
	append(item: T): ChunkedView<T> {
		if (this.tail.length < WINDOW_CHUNK_CAPACITY) {
			const tail = [...this.tail, item];
			projectionPerf.windowRefsCopied += tail.length;
			return new ChunkedView(this.chunks, tail, this.size + 1);
		}
		const chunks = [...this.chunks, this.tail];
		projectionPerf.windowRefsCopied += chunks.length + 1;
		return new ChunkedView(chunks, [item], this.size + 1);
	}

	/** Item at `index`, or `undefined` out of bounds — O(1). */
	get(index: number): T | undefined {
		if (index < 0 || index >= this.size) return undefined;
		const prefixLength = this.size - this.tail.length;
		if (index < prefixLength) {
			const chunk = this.chunks[Math.floor(index / WINDOW_CHUNK_CAPACITY)]!;
			return chunk[index % WINDOW_CHUNK_CAPACITY]!;
		}
		return this.tail[index - prefixLength]!;
	}

	/** Index of the first item matching `predicate`, else −1 — O(size). */
	findIndex(predicate: (item: T) => boolean): number {
		let index = 0;
		for (const chunk of this.chunks) {
			for (const item of chunk) {
				if (predicate(item)) return index;
				index += 1;
			}
		}
		for (const item of this.tail) {
			if (predicate(item)) return index;
			index += 1;
		}
		return -1;
	}

	/**
	 * Materializes the items in order — O(size), COUNTED: every materialized
	 * ref is window-copy work the G-PERF gate must see (an uncounted
	 * materialization is how an O(W) manifest-per-commit hid from the gate).
	 * The same-head read path never calls this — it returns the cached
	 * revision manifest instead.
	 */
	toArray(): T[] {
		projectionPerf.windowRefsCopied += this.size;
		const out: T[] = new Array<T>(this.size);
		let index = 0;
		for (const chunk of this.chunks) {
			for (const item of chunk) {
				out[index] = item;
				index += 1;
			}
		}
		for (const item of this.tail) {
			out[index] = item;
			index += 1;
		}
		return out;
	}
}
