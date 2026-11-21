/**
 * Replicated-state policy (W08 C-invariant, port-plan.md:789): "replicate
 * только разрешённые host states, canonical writes через наш owner".
 *
 * - ALLOWLIST: a chord replicated state source may exist only for a
 *   registered kind; `sourceFor` on an unregistered kind fails closed.
 * - ONE CANONICAL WRITER per kind: the first mutable source wins; a second
 *   `sourceFor` for a live kind throws — replicated state never gets a
 *   bypass canonical writer. Consumers hold the read-only
 *   `Watchable<T>` surface (chord's type system enforces direction;
 *   the mutable `change/replace` surface never leaves this module).
 *
 * @module
 */

import { Watch, type Watchable } from '@earendil-works/chord/watch';
import type { Context } from '@earendil-works/chord/context';
import type { JsonObject } from '@earendil-works/chord';
import { copyJson } from '@earendil-works/chord/json';

/** Product ownership policy over Chord v2's public watch lifecycle. */
class CanonicalState<T extends JsonObject> implements Watchable<T> {
	#value: T;
	readonly #watches = new Set<Watch<T>>();
	constructor(initial: T) {
		this.#value = immutable(initial);
	}
	get value(): T {
		return this.#value;
	}
	async watch(context: Context): Promise<Watch<T>> {
		const watch = new Watch(
			this.#value,
			() => this.#watches.delete(watch),
			() => {},
		);
		this.#watches.add(watch);
		if (context.abortSignal) watch.observeAbort(context.abortSignal);
		watch.advance(
			{
				kind: 'value',
				value: this.#value,
				ops: [['r', this.#value]],
				retired: false,
			},
			context,
		);
		return watch;
	}
	change(context: Context, mutate: (draft: T) => void): void {
		context.abortSignal?.throwIfAborted();
		const next = structuredClone(this.#value);
		mutate(next);
		this.#value = immutable(next);
		for (const watch of this.#watches)
			watch.advance(
				{
					kind: 'value',
					value: this.#value,
					ops: [['r', this.#value]],
					retired: false,
				},
				context,
			);
	}
}

function immutable<T>(value: T): T {
	const copy = copyJson(value) as T;
	const freeze = (item: unknown): void => {
		if (item && typeof item === 'object') {
			for (const child of Object.values(item)) freeze(child);
			Object.freeze(item);
		}
	};
	freeze(copy);
	return copy;
}

/** Fail-closed error of the replicated-state policy. */
export class ReplicatedStatePolicyError extends Error {
	constructor(
		message: string,
		readonly code: 'KIND_NOT_ALLOWED' | 'CANONICAL_WRITER_EXISTS',
	) {
		super(message);
		this.name = 'ReplicatedStatePolicyError';
	}
}

export class ReplicatedStateScope {
	readonly #allowed = new Set<string>();
	readonly #sources = new Map<string, CanonicalState<JsonObject>>();

	constructor(kinds: readonly string[] = []) {
		for (const kind of kinds) this.#allowed.add(kind);
	}

	allow(kind: string): void {
		this.#allowed.add(kind);
	}

	/**
	 * The canonical mutable source of one registered kind. The mutable surface
	 * STAYS HERE — callers publish through {@link publish}; replicas receive
	 * the read-only view.
	 */
	sourceFor<T extends JsonObject>(kind: string, initial: T): Watchable<T> {
		if (!this.#allowed.has(kind)) {
			throw new ReplicatedStatePolicyError(
				`replicated state kind ${kind} is not on the host allowlist`,
				'KIND_NOT_ALLOWED',
			);
		}
		if (this.#sources.has(kind)) {
			throw new ReplicatedStatePolicyError(
				`replicated state kind ${kind} already has a canonical writer`,
				'CANONICAL_WRITER_EXISTS',
			);
		}
		const source = new CanonicalState(initial);
		this.#sources.set(kind, source as unknown as CanonicalState<JsonObject>);
		return this.view<T>(kind);
	}

	/** Publish one change through the canonical writer of `kind`. */
	publish<T extends JsonObject>(
		kind: string,
		mutate: (draft: T) => void,
		context: Context,
	): void {
		const source = this.#sources.get(kind) as CanonicalState<T> | undefined;
		if (source === undefined) {
			throw new ReplicatedStatePolicyError(
				`replicated state kind ${kind} has no live source`,
				'CANONICAL_WRITER_EXISTS',
			);
		}
		source.change(context, mutate as never);
	}

	/** The read-only view handed to replicas/consumers. */
	view<T extends JsonObject>(kind: string): Watchable<T> {
		const source = this.#sources.get(kind) as CanonicalState<T> | undefined;
		if (source === undefined) {
			throw new ReplicatedStatePolicyError(
				`replicated state kind ${kind} has no live source`,
				'CANONICAL_WRITER_EXISTS',
			);
		}
		return {
			get value() {
				return source.value;
			},
			watch: (context) => source.watch(context),
		};
	}
}
