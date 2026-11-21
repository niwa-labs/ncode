/**
 * W02 part B (PORT-PI-1.3): the CAS publish-before-reference validator for
 * pi storage commits — I09 ("CAS ref привязан к hash/size/content, blob
 * публикуется до committed ссылки") and C1 invariant 5 ("CAS blob
 * опубликован до ссылки на него").
 *
 * Plugs into the storage-worker's pi single-writer composition as the
 * `onBeforeCommit` hook (or composes with other validators, e.g. the seed
 * publication gate): before a pi write batch is handed to storage, every
 * `cas://sha256/<digest>#<size>` reference it carries — anywhere in any
 * record family's JSON, including inside the mcode bridge envelopes of the
 * log port — must resolve to an ALREADY PUBLISHED blob. A dangling
 * reference fails that one commit (a validation rejection: nothing durable
 * happened, the writer gate stays usable) instead of becoming a committed
 * reference to nothing.
 *
 * The reference format is THE single definition in `@mavis/cas/cas-ref`
 * (`casSpillRef`/`parseCasSpillRef`); this module only traverses and asks
 * the store — it never restates the pattern. Existence (`hasAsync`) is the
 * publication invariant; full hash/size verification stays with the store's
 * read path (`CasStore.get` with `expectedSize`), which a pre-commit hook
 * must not re-run for cost (I02: the hook runs per commit, off the input
 * loop, but must stay O(new bytes) — it walks exactly the pending batch).
 *
 * @module
 */

import { parseCasSpillRef } from '@mavis/cas/cas-ref';

/**
 * Minimal structural surface of `@mavis/cas`'s `CasStore` this validator
 * needs (the real store satisfies it as-is).
 */
export interface CasExistenceLike {
	hasAsync(sha256: string): Promise<boolean>;
}

/** Structural mirror of one pi `StorageWrite` (see `@mavis/storage-worker`). */
interface PiWriteLike {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** Validation rejection: a pending commit references an unpublished blob. */
export class CasRefUnpublishedError extends Error {
	readonly sha256: string;
	constructor(sha256: string) {
		super(`CAS blob ${sha256} is referenced by the commit but not published yet`);
		this.name = 'CasRefUnpublishedError';
		this.sha256 = sha256;
	}
}

/** Validation rejection: a pending commit references more blobs than the validator's cap. */
export class CasRefBudgetExceededError extends Error {
	constructor(refCount: number, cap: number) {
		super(
			`the commit references ${String(refCount)} distinct CAS blobs, above the validator cap ${String(cap)}`,
		);
		this.name = 'CasRefBudgetExceededError';
	}
}

/**
 * Collects every `cas://sha256/<digest>#<size>` reference inside a JSON
 * value (writes of any record family, bridge envelopes included). String
 * scanning is exact — `parseCasSpillRef` anchors the pattern, so a foreign
 * string never yields a wrong digest.
 */
export function collectCasRefDigests(value: unknown, into: Set<string> = new Set()): Set<string> {
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (typeof current === 'string') {
			// cas:// refs are short and self-delimited; skip long strings fast.
			if (current.length <= 128 && current.startsWith('cas://')) {
				const parsed = parseCasSpillRef(current);
				if (parsed !== null) into.add(parsed.sha256);
			}
			continue;
		}
		if (Array.isArray(current)) {
			for (const item of current) stack.push(item);
			continue;
		}
		if (typeof current === 'object' && current !== null) {
			for (const key of Object.keys(current as Record<string, unknown>)) {
				stack.push((current as Record<string, unknown>)[key]);
			}
		}
	}
	return into;
}

/** Options of {@link createCasPreCommitValidator}. */
export interface CasPreCommitValidatorOptions {
	/**
	 * Maximum number of DISTINCT blob digests one commit may reference.
	 * Guards the hook's own cost against a pathological batch full of
	 * references; the check is O(1) per digest after collection.
	 * Default 4096.
	 */
	readonly maxRefsPerCommit?: number;
}

/**
 * Builds the `onBeforeCommit` validator: every pending pi write batch is
 * scanned for CAS references and each digest is checked against the store.
 * Unpublished blob ⇒ the commit is rejected (fail that commit only);
 * nothing durable happened, so the publication order — blob first,
 * reference second — is restored by simply publishing the blob and retrying
 * the commit as an explicit operation.
 */
export function createCasPreCommitValidator(
	cas: CasExistenceLike,
	options: CasPreCommitValidatorOptions = {},
): (writes: readonly PiWriteLike[]) => Promise<void> {
	const maxRefs = options.maxRefsPerCommit ?? 4096;
	return async (writes: readonly PiWriteLike[]): Promise<void> => {
		const digests = new Set<string>();
		for (const write of writes) collectCasRefDigests(write, digests);
		if (digests.size === 0) return;
		if (digests.size > maxRefs) {
			throw new CasRefBudgetExceededError(digests.size, maxRefs);
		}
		for (const sha256 of digests) {
			if (!(await cas.hasAsync(sha256))) {
				throw new CasRefUnpublishedError(sha256);
			}
		}
	};
}
