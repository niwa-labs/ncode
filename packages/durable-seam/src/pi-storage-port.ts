/**
 * W02 part B (PORT-PI-1.3): the seam's `DurableLogPort` implemented over a
 * FULL pi `Storage` — U05 ("seam/port/snapshot … остаются поверх полного pi
 * Storage") and §4 row 1 of the merge map ("Наш узкий `DurableLogPort` не
 * выдаётся за весь pi Storage" — it stays a port, but it composes OVER the
 * pi Storage contract instead of only over the sqlite-zstd backend).
 *
 * Composition: one minted pi conversation hosts the mcode log. Every
 * {@link DurableLogPort.appendBatch} becomes ONE pi `Storage.commit` —
 * conversation creation (first append only) plus one entry write per draft,
 * atomically — so the port's batch-atomicity guarantee rests on pi's atomic
 * commit, the same way the sqlite-zstd port rests on the backend's
 * `appendBatch` transaction.
 *
 * Identity domains (schema fixed in `@mavis/durable-core/src/pi-id-domains.ts`):
 * - the numeric pi `EntryId` of every entry is allocated through
 *   `storage.mintId()` — never derived from the mcode string id;
 * - the mcode entry id survives inside the versioned bridge envelope stored
 *   as the pi `EntryRecord.data`;
 * - pi `Seq` PERMITS GAPS: the port never assumes `seq === index + 1` and
 *   never renders pi's `EntryId`-shaped context head. `PortCommit.head` is
 *   the port's OWN last-commit sequence — a port-local equation documented
 *   here, exactly like the backend-local `head === seq` of sqlite-zstd
 *   (identity-domains.md rule 2: neither equation is universal).
 *
 * Sync/async impedance, resolved at the boundary: pi `Storage` is async but
 * `DurableLogPort` reads are synchronous. The factory is therefore ASYNC
 * ({@link openPiStorageDurableLogPort}): recovery streams the bridge
 * conversation ONCE in bounded pages — the recovery path I03 explicitly
 * budgets for open/resume — and from then on every read answers
 * synchronously from two structures with different memory budgets:
 *
 * - a METADATA index of every committed batch (`BatchMeta`: seq, entry
 *   count, byte size, first pi EntryId) plus a position index of every
 *   mcode entry id — the port's equivalent of the incumbent backend's
 *   durable SQL indexes: O(#commits) small fixed records that never carry
 *   payloads, without which `head`, budget math and honest absent-vs-loaded
 *   point reads are impossible;
 * - a BOUNDED retained window of whole batches WITH payloads
 *   (`retainedWindowBytes`, LRU by batch). Warm appends land in the window
 *   incrementally; when the cap is exceeded the oldest resident batches are
 *   evicted — a fixed byte budget instead of a whole-log mirror (I03:
 *   "capsule + bounded pages", never "capsule + the log"). A single batch
 *   larger than the cap stays resident alone: batches are atomic units, the
 *   cap never splits one.
 *
 * `readDeltaChecked` SEEKS the metadata index by `afterSeq` (binary search;
 * commits serialize through the port, so batch seqs are strictly ascending)
 * and walks only the batches of the requested window — O(log B + Δ) per
 * call and O(H) for a full recovery walk, not the O(H)-per-window scan the
 * W02 review round 1 flagged against I03. A window whose first batch is no
 * longer resident fails CLOSED with `PI_WINDOW_EVICTED` — an explicit
 * error, never a silently empty window that would confuse "evicted" with
 * "end of the log" — and the async {@link PiStorageLogPort.loadWindowAfter}
 * pages the needed batches back in, anchored at each batch's first EntryId
 * (bounded pages again, no rescan from the log start).
 *
 * Torn tails (the port contract: "reports a torn tail explicitly instead of
 * confusing it with the end of the log"): the resident window is the port's
 * own just-committed data and cannot be torn, so warm reads report `null`.
 * Damage that appears AFTER open is discovered exactly where reads touch
 * the storage again — the `loadWindowAfter` page loads. A storage-layer
 * failure there (a torn zstd frame in the sqlite-zstd adapter, for example)
 * is recorded as a torn verdict at the batch's seq and surfaces through
 * every following `readDeltaChecked` whose walk reaches it, as
 * `tornTail: { batchId: <pi commit Seq>, reason }`. A FOREIGN entry — data
 * present but not a valid bridge envelope — stays a fail-closed
 * `PI_BRIDGE_ENVELOPE_INVALID` throw both at open and on reload: a
 * single-writer violation (I01) is an invariant breach, not a degradation
 * to walk past. `batchId` is this port's batch identity, the pi commit Seq,
 * exactly like the sqlite-zstd port's is the backend's batch id.
 *
 * Fail-closed single-writer guard: a foreign entry (no valid bridge
 * envelope) in the bridge conversation means someone else wrote into the
 * port's conversation — the open refuses to interpret it (I01: no second
 * writer) instead of silently skipping or rewriting it.
 *
 * The pi surface is mirrored STRUCTURALLY (the package stays
 * dependency-free; pi's erased numeric brands are bridged with one explicit
 * cast at the composition boundary, never by silent coercion). The vendored
 * reference `MemoryStorage` and W02 part A's sqlite-zstd adapter both plug
 * in.
 *
 * @module
 */

import { createLogger } from '@mavis/logging';

import { SeamStorageError } from './errors.js';
import type {
	DurableLogPort,
	PortCommit,
	PortDelta,
	PortEntry,
	PortEntryDraft,
} from './port.js';
import type { JsonValue } from './types.js';

/** Same namespace as the seam core (spec §4); module-level singleton. */
const log = createLogger('mcode:seam');

// ---------------------------------------------------------------------------
// Structural mirrors of the pi Storage surface this port consumes
// (pin third_party/pi-durable/src/types.ts:1179-1274)
// ---------------------------------------------------------------------------

/**
 * Structural mirror of the pi `EntryRecord` fields this port reads and
 * writes. Only the fields the port uses are declared; pi's richer optional
 * fields (`model`, `head`, `edits`, `byTaskId`, …) are simply not touched.
 */
export interface PiEntryRecordLike {
	readonly id: number;
	readonly conversationId: number;
	readonly kind: string;
	readonly data?: unknown;
}

/**
 * Structural mirror of the two `StorageWrite` members the port produces
 * (pin `types.ts:852-854`).
 */
export type PiStorageWriteLike =
	| { readonly type: 'conversation'; readonly value: { readonly id: number } }
	| { readonly type: 'entry'; readonly value: PiEntryRecordLike };

/** Mirror of `Storage.entry(conversationId, id)`'s result. */
export interface PiEntryLookup {
	readonly entry: PiEntryRecordLike;
	readonly commitSeq: number;
}

/** Mirror of pi `Cursor` (opaque JSON continuation state). */
export type PiCursorLike = Readonly<Record<string, unknown>>;

/** Mirror of pi `Page`. */
export interface PiPageLike {
	readonly items: readonly PiEntryRecordLike[];
	readonly next?: PiCursorLike;
}

/** Mirror of pi `EntryQuery` (fork-aware inclusive scan of one conversation). */
export interface PiEntryQueryLike {
	readonly conversationId: number;
	readonly minEntryId?: number;
	readonly maxEntryId?: number;
	readonly order?: 'ascending' | 'descending';
}

/**
 * Minimal structural surface of a full pi `Storage` this port composes
 * over. `commit` resolves with the pi commit `Seq` (a number); `mintId`
 * allocates from the storage-global numeric namespace. `entry` is the
 * GLOBAL two-argument overload (`entry(id, context)` — pin
 * `types.ts:1203`): EntryIds are globally unique, so the rebuild resolves
 * an id's record and commit sequence without an ancestry walk; the port
 * only asks about ids its own conversation scan produced.
 */
export interface PiStorageLike {
	/**
	 * The chord-era commit protocol (pi-durable 1.5.2): ONE call carries the
	 * series of batches (our port always sends exactly one), a `receive`
	 * callback collects each batch's durable `Seq` as the storage assigns
	 * them, and the result reports how many batches stored plus the FIRST
	 * refusal, if the series stopped early.
	 */
	commit(
		batches: readonly (readonly PiStorageWriteLike[])[],
		receive: (index: number, seq: number) => void,
		context?: unknown,
	): Promise<
		| { readonly kind: 'stored'; readonly stored: number }
		| { readonly kind: 'refused'; readonly stored: number; readonly refused: unknown }
	>;
	mintId(): Promise<number>;
	entry(id: number): Promise<PiEntryLookup | undefined>;
	scanEntries(
		query: PiEntryQueryLike,
		limit: number,
		cursor: PiCursorLike | undefined,
	): Promise<PiPageLike>;
}

// ---------------------------------------------------------------------------
// The bridge envelope (schema fixed in @mavis/durable-core, W02-D)
// ---------------------------------------------------------------------------

/** Version of the envelope this port stores in `EntryRecord.data`. */
export const PI_BRIDGE_ENVELOPE_VERSION = 1;

/** Typed envelope stored as pi `EntryRecord.data`. */
export interface PiBridgeEnvelope {
	readonly v: typeof PI_BRIDGE_ENVELOPE_VERSION;
	readonly mcodeEntryId: string;
	readonly payload: JsonValue;
}

/** Encodes one draft into the bridge envelope (`EntryRecord.data`). */
export function encodePiBridgeEnvelope(draft: PortEntryDraft): PiBridgeEnvelope {
	return { v: PI_BRIDGE_ENVELOPE_VERSION, mcodeEntryId: draft.id, payload: draft.payload };
}

/**
 * Decodes a stored `EntryRecord.data` back into the envelope. Fail-closed: a
 * malformed or foreign-versioned envelope throws `PI_BRIDGE_ENVELOPE_INVALID`
 * — the bridge conversation is exclusively the port's, and anything else is
 * a single-writer violation to surface, not to skip (I01).
 */
export function decodePiBridgeEnvelope(data: unknown, entryId: number): PiBridgeEnvelope {
	const candidate =
		typeof data === 'object' && data !== null
			? (data as { readonly v?: unknown; readonly mcodeEntryId?: unknown })
			: null;
	if (
		candidate === null ||
		candidate.v !== PI_BRIDGE_ENVELOPE_VERSION ||
		typeof candidate.mcodeEntryId !== 'string' ||
		candidate.mcodeEntryId.length === 0 ||
		!('payload' in candidate)
	) {
		throw new SeamStorageError(
			'PI_BRIDGE_ENVELOPE_INVALID',
			`pi entry ${String(entryId)} does not carry a v${String(PI_BRIDGE_ENVELOPE_VERSION)} mcode bridge envelope`,
		);
	}
	return candidate as PiBridgeEnvelope;
}

// ---------------------------------------------------------------------------
// Index state
// ---------------------------------------------------------------------------

/** One indexed mcode entry with its pi-mapped position and serialized size. */
interface IndexedEntry {
	readonly entry: PortEntry;
	/** Serialized envelope size in bytes (the read-budget unit of this port). */
	readonly bytes: number;
}

/**
 * Metadata of one committed batch — this port's equivalent of the incumbent
 * backend's durable SQL index rows. `seq` is the seek key (commits serialize
 * through the port, so seqs are strictly ascending), `count`/`bytes` drive
 * the window budget math, and `firstEntryId` anchors bounded reloads
 * (`scanEntries({ minEntryId })` seeks straight to the batch). Payloads
 * never live here: the index is O(#commits) small fixed records.
 */
interface BatchMeta {
	readonly seq: number;
	readonly count: number;
	readonly bytes: number;
	readonly firstEntryId: number;
}

/** One batch whose entry payloads are currently resident in the bounded window. */
interface LoadedBatch {
	readonly seq: number;
	readonly entries: readonly IndexedEntry[];
	readonly bytes: number;
}

/** Result of an explicit window reload ({@link PiStorageLogPort.loadWindowAfter}). */
export interface PiWindowLoadReport {
	/** Batches resident in the walk's span after the call (fresh + already loaded). */
	readonly loadedBatches: number;
	readonly loadedEntries: number;
	/** Seq of the first batch the load stopped at without covering; null on a clean end. */
	readonly stoppedAtSeq: number | null;
	/** Damage reason when the stop was a torn batch; null on a budget stop or clean end. */
	readonly tornReason: string | null;
}

/** Observability of the bounded retained window (the port's I03 memory budget). */
export interface PiWindowStats {
	/** Payload bytes currently resident — bounded by `retainedWindowBytes` (or one oversized batch). */
	readonly retainedBytes: number;
	readonly retainedBatches: number;
	/** Every batch the port knows since open (metadata index size — payloads not included). */
	readonly totalBatches: number;
	/** Batches whose payloads are not resident right now (evicted; reloadable via `loadWindowAfter`). */
	readonly evictedBatches: number;
}

/**
 * Default byte cap of the retained payload window: 4× the seam's recovery
 * window (`DEFAULT_RECOVERY_WINDOW_BYTES` = 8 MiB in `seam.ts`), so the
 * window always spans several full recovery walks plus the recent snapshot
 * horizon the seam's `recover` probes, while staying a FIXED budget instead
 * of a whole-log mirror (I03: "capsule + bounded pages").
 */
const DEFAULT_RETAINED_WINDOW_BYTES = 32 * 1024 * 1024;

/** Options of {@link openPiStorageDurableLogPort}. */
export interface PiStoragePortOptions {
	/**
	 * Explicit bridge conversation for REOPENING a storage that already
	 * hosts a port log (read it from {@link PiStorageLogPort.bridgedConversationId}
	 * of the original instance and persist it beside the root). When omitted,
	 * the port starts from an empty index and mints its conversation lazily
	 * on the first append.
	 */
	readonly conversationId?: number;
	/** Page size of the recovery scan and window reloads (pi scanEntries limit). Default 256. */
	readonly scanPageSize?: number;
	/**
	 * Byte cap of the retained payload window (LRU by whole batches;
	 * default {@link DEFAULT_RETAINED_WINDOW_BYTES} = 32 MiB). Batches are
	 * atomic units: a single batch larger than the cap stays resident alone,
	 * so the cap is a target the port never splits a batch to meet. Reads of
	 * an evicted batch fail closed with `PI_WINDOW_EVICTED` and reload
	 * through `loadWindowAfter`.
	 */
	readonly retainedWindowBytes?: number;
}

/** The port handle returned by {@link openPiStorageDurableLogPort}. */
export interface PiStorageLogPort extends DurableLogPort {
	/**
	 * The pi conversation hosting this log. `null` until the first append
	 * mints it; persist this beside the durable root so a later open can
	 * pass it back as `options.conversationId` (root-resolver contract).
	 */
	readonly bridgedConversationId: number | null;
	/**
	 * Reloads the batches after `afterSeq` into the retained window from the
	 * pi Storage, in bounded pages anchored at each batch's first EntryId —
	 * never a rescan from the log start. Budget defaults to the retained
	 * window cap; at least one batch is always covered. Storage-layer
	 * failures during the load become torn verdicts surfaced by the
	 * following `readDeltaChecked` calls (see the module doc); a foreign
	 * entry still fails closed with `PI_BRIDGE_ENVELOPE_INVALID`.
	 */
	loadWindowAfter(afterSeq: number, limitBytes?: number): Promise<PiWindowLoadReport>;
	/** Current state of the bounded retained window (observability for the I03 budget). */
	windowStats(): PiWindowStats;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Opens the seam's {@link DurableLogPort} over a full pi `Storage` — the W02
 * bridge that lets the seam (and everything composing it) run on top of the
 * pi Storage contract: the vendored reference implementations during the
 * port, and W02 part A's sqlite-zstd adapter in the product.
 *
 * The open is async because the pi surface is async: it streams the bridge
 * conversation once in bounded pages (validating every record and resolving
 * commit sequences through point reads — the I03-budgeted recovery pass),
 * keeping the metadata index for every batch but only the bounded tail of
 * payloads resident. After the open, reads are synchronous. Batch atomicity:
 * one `appendBatch` = one pi commit (conversation creation rides in the
 * FIRST commit only).
 */
export async function openPiStorageDurableLogPort(
	storage: PiStorageLike,
	options: PiStoragePortOptions = {},
): Promise<PiStorageLogPort> {
	const scanPageSize = options.scanPageSize ?? 256;
	const retainedWindowBytes = options.retainedWindowBytes ?? DEFAULT_RETAINED_WINDOW_BYTES;
	let conversationId: number | null = options.conversationId ?? null;
	/** Metadata index: every batch since open, strictly ascending seq (seek key). */
	const batchIndex: BatchMeta[] = [];
	/** Position of every mcode entry id (the `entry_id`-index equivalent; no payloads). */
	const idIndex = new Map<string, { readonly seq: number; readonly ordinal: number }>();
	/** Resident payload window: seq → batch, LRU order (Map insertion order). */
	const loaded = new Map<number, LoadedBatch>();
	let loadedBytes = 0;
	/** Torn batches discovered by window reloads: batch seq → damage reason. */
	const torn = new Map<number, string>();
	let totalEntries = 0;
	/** Mutations serialize (single writer on the port side, too). */
	let appendTail: Promise<unknown> = Promise.resolve();

	const envelopeBytes = (envelope: PiBridgeEnvelope): number =>
		Buffer.byteLength(JSON.stringify(envelope), 'utf8');

	/** Marks a resident batch most-recently-used (Map insertion order = LRU order). */
	const touch = (seq: number, batch: LoadedBatch): void => {
		loaded.delete(seq);
		loaded.set(seq, batch);
	};

	/** Inserts/replaces a resident batch, then evicts oldest batches over the cap. */
	const insertLoaded = (batch: LoadedBatch): void => {
		const previous = loaded.get(batch.seq);
		if (previous !== undefined) {
			loadedBytes -= previous.bytes;
			loaded.delete(batch.seq);
		}
		loaded.set(batch.seq, batch);
		loadedBytes += batch.bytes;
		torn.delete(batch.seq); // a successful (re)load clears any stale torn verdict
		while (loadedBytes > retainedWindowBytes && loaded.size > 1) {
			const oldest = loaded.keys().next().value;
			if (oldest === undefined) break;
			loadedBytes -= loaded.get(oldest)!.bytes;
			loaded.delete(oldest);
			log.debug('pi storage port window evicted a batch', { seq: oldest });
		}
	};

	/** Binary seek: index of the first batch with `seq > afterSeq` (ascending seqs). */
	const firstBatchAfter = (afterSeq: number): number => {
		let lo = 0;
		let hi = batchIndex.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (batchIndex[mid]!.seq > afterSeq) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	};

	if (conversationId !== null) {
		// Recovery: stream the whole bridge conversation in bounded pages,
		// validating every envelope (I01) and resolving each entry's commit
		// sequence through point reads. Ascending EntryId order IS mint order
		// IS commit order, so batches rebuild by grouping consecutive
		// same-seq entries. Only the metadata index and the bounded TAIL of
		// payloads stay resident — earlier batches evict as the window fills,
		// so open memory is one transient page plus the retained window, not
		// a whole-log mirror (I03).
		let cursor: PiCursorLike | undefined;
		let pending: { seq: number; firstEntryId: number; entries: IndexedEntry[]; bytes: number } | null =
			null;
		const closeBatch = (): void => {
			if (pending === null) return;
			const meta: BatchMeta = {
				seq: pending.seq,
				count: pending.entries.length,
				bytes: pending.bytes,
				firstEntryId: pending.firstEntryId,
			};
			batchIndex.push(meta);
			insertLoaded({ seq: meta.seq, entries: pending.entries, bytes: meta.bytes });
			pending = null;
		};
		do {
			const page = await storage.scanEntries(
				{ conversationId, order: 'ascending' },
				scanPageSize,
				cursor,
			);
			for (const record of page.items) {
				const envelope = decodePiBridgeEnvelope(record.data, record.id);
				const lookup = await storage.entry(record.id);
				if (lookup === undefined) {
					throw new SeamStorageError(
						'STORAGE_FAILURE',
						`pi entry ${String(record.id)} vanished between scan and point read`,
					);
				}
				if (pending === null || lookup.commitSeq !== pending.seq) {
					closeBatch();
					pending = { seq: lookup.commitSeq, firstEntryId: record.id, entries: [], bytes: 0 };
				}
				const item: IndexedEntry = {
					entry: {
						id: envelope.mcodeEntryId,
						kind: record.kind,
						payload: envelope.payload,
						seq: lookup.commitSeq,
						ordinal: pending.entries.length,
					},
					bytes: envelopeBytes(envelope),
				};
				pending.entries.push(item);
				pending.bytes += item.bytes;
				idIndex.set(item.entry.id, { seq: item.entry.seq, ordinal: item.entry.ordinal });
				totalEntries += 1;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		closeBatch();
		log.debug('pi storage port index rebuilt', {
			conversationId,
			entries: totalEntries,
			batches: batchIndex.length,
		});
	}

	const serializeAppend = <T>(op: () => Promise<T>): Promise<T> => {
		const next = appendTail.then(op, op);
		appendTail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	/**
	 * Pages one batch's records in from the storage, anchored at the batch's
	 * first EntryId — bounded pages, never a rescan from the log start.
	 * Positions follow the metadata index (ascending EntryId order IS commit
	 * order, the same invariant the open rebuild relies on) and every record
	 * is cross-checked against the id index, so a foreign writer or drift
	 * fails closed instead of silently misaligning positions. No point reads:
	 * the index already carries the batch grouping.
	 */
	const loadBatchFromStorage = async (meta: BatchMeta): Promise<LoadedBatch> => {
		const entries: IndexedEntry[] = [];
		let cursor: PiCursorLike | undefined;
		while (entries.length < meta.count) {
			const page = await storage.scanEntries(
				{
					conversationId: conversationId!,
					minEntryId: entries.length === 0 ? meta.firstEntryId : undefined,
					order: 'ascending',
				},
				scanPageSize,
				cursor,
			);
			for (const record of page.items) {
				if (entries.length >= meta.count) break; // page over-served into the next batch
				const envelope = decodePiBridgeEnvelope(record.data, record.id);
				const expected = idIndex.get(envelope.mcodeEntryId);
				if (
					expected === undefined ||
					expected.seq !== meta.seq ||
					expected.ordinal !== entries.length
				) {
					throw new SeamStorageError(
						'STORAGE_FAILURE',
						`pi entry ${String(record.id)} does not sit at the indexed position of ${JSON.stringify(
							envelope.mcodeEntryId,
						)} (batch seq ${String(meta.seq)}, ordinal ${String(entries.length)}); the bridge conversation drifted from the index rebuilt at open`,
					);
				}
				entries.push({
					entry: {
						id: envelope.mcodeEntryId,
						kind: record.kind,
						payload: envelope.payload,
						seq: meta.seq,
						ordinal: entries.length,
					},
					bytes: envelopeBytes(envelope),
				});
			}
			cursor = page.next;
			if (cursor === undefined && entries.length < meta.count) {
				throw new SeamStorageError(
					'STORAGE_FAILURE',
					`the bridge conversation ended before batch seq ${String(meta.seq)} delivered its ${String(meta.count)} indexed entries`,
				);
			}
		}
		return { seq: meta.seq, entries, bytes: meta.bytes };
	};

	const port: PiStorageLogPort = {
		get bridgedConversationId(): number | null {
			return conversationId;
		},

			appendBatch(entries: readonly PortEntryDraft[]): Promise<PortCommit> {
				if (entries.length === 0) {
					return Promise.reject(
						new SeamStorageError('STORAGE_FAILURE', 'appendBatch requires a non-empty batch'),
					);
				}
				return serializeAppend(async () => {
					try {
						const writes: PiStorageWriteLike[] = [];
						if (conversationId === null) {
							conversationId = await storage.mintId();
							writes.push({ type: 'conversation', value: { id: conversationId } });
						}
						const fresh: IndexedEntry[] = [];
						let firstEntryId = 0;
						let batchBytes = 0;
						for (const draft of entries) {
							// Numeric id from the storage's own monotonic namespace —
							// never derived from the string id (identity-domains rule 3).
							const numericId = await storage.mintId();
							if (fresh.length === 0) firstEntryId = numericId;
							const envelope = encodePiBridgeEnvelope(draft);
							const bytes = envelopeBytes(envelope);
							writes.push({
								type: 'entry',
								value: {
									id: numericId,
									conversationId,
									kind: draft.kind,
									data: envelope,
								},
							});
							fresh.push({
								entry: {
									id: draft.id,
									kind: draft.kind,
									payload: draft.payload,
									seq: 0,
									ordinal: fresh.length,
								},
								bytes,
							});
							batchBytes += bytes;
						}
						// ONE pi commit for the whole batch (conversation creation
						// rides along atomically on the first append). The chord-era
						// protocol wraps our single batch in the series array and
						// receives the durable seq through the callback; a refusal
						// means the batch changed nothing.
						let seq = 0;
						const result = await storage.commit([writes], (_index, received) => {
							seq = received;
						});
						if (result.kind === 'refused') {
							throw result.refused instanceof Error
								? result.refused
								: new Error(String(result.refused));
						}
						const stamped: IndexedEntry[] = fresh.map((item) => ({
							...item,
							entry: { ...item.entry, seq },
						}));
						batchIndex.push({
							seq,
							count: stamped.length,
							bytes: batchBytes,
							firstEntryId,
						});
						for (const item of stamped) {
							idIndex.set(item.entry.id, { seq, ordinal: item.entry.ordinal });
						}
						insertLoaded({ seq, entries: stamped, bytes: batchBytes });
						totalEntries += stamped.length;
						log.debug('pi storage port batch committed', {
							seq,
							entries: stamped.length,
							conversationId,
						});
						return { seq, head: seq, entryCount: stamped.length };
					} catch (error) {
						throw mapPiStorageError(error, 'appendBatch');
					}
				});
			},

			getEntry(entryId: string): PortEntry | undefined {
				const position = idIndex.get(entryId);
				if (position === undefined) return undefined; // genuinely absent — the honest undefined
				const batch = loaded.get(position.seq);
				if (batch === undefined) {
					// Evicted: returning undefined would claim absence and break
					// dedup correctness — fail closed instead (module doc).
					throw new SeamStorageError(
						'PI_WINDOW_EVICTED',
						`entry ${JSON.stringify(entryId)} (batch seq ${String(position.seq)}) left the ${String(retainedWindowBytes)}-byte retained window; reload it with loadWindowAfter(${String(position.seq - 1)})`,
					);
				}
				touch(position.seq, batch);
				return batch.entries[position.ordinal]!.entry;
			},

			readDeltaChecked(afterSeq: number, limitBytes: number): PortDelta {
				// SEEK the metadata index (strictly ascending seqs) instead of
				// scanning it, then walk only the window's whole batches,
				// oldest first, within the byte budget — always at least one
				// batch, like the sqlite-zstd port's index seek. O(log B + Δ).
				const entries: PortEntry[] = [];
				let bytes = 0;
				let nextAfterSeq: number | null = null;
				let tornTail: PortDelta['tornTail'] = null;
				for (let i = firstBatchAfter(afterSeq); i < batchIndex.length; i += 1) {
					const meta = batchIndex[i]!;
					if (entries.length > 0 && bytes + meta.bytes > limitBytes) break; // budget stop
					const batch = loaded.get(meta.seq);
					if (batch === undefined) {
						const reason = torn.get(meta.seq);
						if (reason !== undefined) {
							// Damage discovered by a reload: explicit verdict, never
							// "end of the log" (port contract).
							tornTail = { batchId: meta.seq, reason };
						} else if (entries.length === 0) {
							throw new SeamStorageError(
								'PI_WINDOW_EVICTED',
								`the window after seq ${String(afterSeq)} starts at batch seq ${String(meta.seq)}, which left the ${String(retainedWindowBytes)}-byte retained window; reload it with loadWindowAfter(${String(afterSeq)})`,
							);
						}
						// Mid-walk eviction: stop on the cursor — the caller
						// reloads from `nextAfterSeq` and continues.
						break;
					}
					touch(meta.seq, batch);
					for (const item of batch.entries) entries.push(item.entry);
					bytes += meta.bytes;
					nextAfterSeq = meta.seq;
				}
				const headSeq = batchIndex.length > 0 ? batchIndex[batchIndex.length - 1]!.seq : 0;
				return {
					entries,
					nextAfterSeq: nextAfterSeq !== null && nextAfterSeq < headSeq ? nextAfterSeq : null,
					tornTail,
				};
			},

			head(): number {
				return batchIndex.length > 0 ? batchIndex[batchIndex.length - 1]!.seq : 0;
			},

			maxBatchBytes(): number | null {
				// A pi Storage does not bound batch bytes; admission caps are the
				// adapter's own contract (part A). The seam falls back to its
				// default input budget — documented, not guessed.
				return null;
			},

			loadWindowAfter(afterSeq: number, limitBytes: number = retainedWindowBytes): Promise<PiWindowLoadReport> {
				// Window reloads mutate the retained window; serialize behind the
				// appends so inserts/evictions never interleave (single writer).
				return serializeAppend(async () => {
					if (conversationId === null || batchIndex.length === 0) {
						return { loadedBatches: 0, loadedEntries: 0, stoppedAtSeq: null, tornReason: null };
					}
					let loadedBatches = 0;
					let loadedEntries = 0;
					let budgetBytes = 0;
					let stoppedAtSeq: number | null = null;
					let tornReason: string | null = null;
					for (let i = firstBatchAfter(afterSeq); i < batchIndex.length; i += 1) {
						const meta = batchIndex[i]!;
						if (loadedBatches > 0 && budgetBytes + meta.bytes > limitBytes) {
							stoppedAtSeq = meta.seq; // budget stop — not damage
							break;
						}
						if (loaded.has(meta.seq)) {
							loadedBatches += 1;
							loadedEntries += meta.count;
							budgetBytes += meta.bytes;
							continue;
						}
						let batch: LoadedBatch;
						try {
							batch = await loadBatchFromStorage(meta);
						} catch (error) {
							if (
								error instanceof SeamStorageError &&
								(error.code === 'PI_BRIDGE_ENVELOPE_INVALID' || error.code === 'STORAGE_FAILURE')
							) {
								// Foreign entry (I01) or index drift: fail closed —
								// single-writer invariants are not degradation.
								throw error;
							}
							// A storage-layer failure while paging the batch in
							// (e.g. a torn zstd frame): torn verdict at this batch,
							// surfaced by the following readDeltaChecked calls.
							tornReason = error instanceof Error ? error.message : String(error);
							torn.set(meta.seq, tornReason);
							stoppedAtSeq = meta.seq;
							log.warn('pi storage port window reload stopped on a torn batch', {
								seq: meta.seq,
								reason: tornReason,
								afterSeq,
							});
							break;
						}
						insertLoaded(batch);
						loadedBatches += 1;
						loadedEntries += meta.count;
						budgetBytes += meta.bytes;
					}
					return { loadedBatches, loadedEntries, stoppedAtSeq, tornReason };
				});
			},

			windowStats(): PiWindowStats {
				return {
					retainedBytes: loadedBytes,
					retainedBatches: loaded.size,
					totalBatches: batchIndex.length,
					evictedBatches: batchIndex.length - loaded.size,
				};
			},
		};

	return port;
}

// ---------------------------------------------------------------------------
// Error mapping (the seam hierarchy; structural, like sqlite-zstd-port.ts)
// ---------------------------------------------------------------------------

/**
 * Maps a pi storage error into the seam hierarchy. The port never loads the
 * producing implementation, so recognition stays structural; every mapped
 * failure is fail-closed for the caller and logged before the throw.
 */
function mapPiStorageError(error: unknown, op: string): unknown {
	if (error instanceof SeamStorageError) return error;
	const mapped = new SeamStorageError(
		'STORAGE_FAILURE',
		error instanceof Error ? error.message : String(error),
		{ cause: error },
	);
	log.error('pi storage port call failed', {
		op,
		code: mapped.code,
		err: error instanceof Error ? error : new Error(String(error)),
	});
	return mapped;
}
