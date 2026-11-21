// REAL writer forms of the inline assistant billing shape (a) — W05 review
// pass 2, remark 1.
//
// `inlineAssistantUsage` must fold the records ACTUAL writers produce, not a
// synthetic flat `{role, provider, model, usage}` object (the shape the
// original test used — one no writer in the repo or the donor writes). Three
// real spellings, built here EXACTLY as their writers build them:
//
//   1. the DONOR record: pi-durable `appendAssistant`
//      (third_party/pi-durable/src/harness/generation.ts:743-750) does
//      `tx.appendEntry(AssistantEntry, conversationId, { model: [message] })`,
//      which stores an `EntryRecord` (pi-durable types.ts:428-443) — the
//      message array is a TOP-LEVEL `model` field of the record, and the
//      message itself is the FULL pi-ai `AssistantMessage` (api, timestamp,
//      durationMs, optional cacheWrite1h/reasoning splits — pi-ai
//      types.ts:570-601);
//   2. OUR W02 adapter's wrapping of that record: `pi-storage.ts:881-886`
//      stores the EntryRecord VERBATIM as the payload of a `pi.record`
//      durable entry (kind from `pi-ids.ts`, id `pi.entry.<id>`) — the live
//      round-trip through the real adapter is pinned in
//      durable-backend-sqlite-zstd/test/pi-storage-usage-roundtrip.test.ts;
//   3. the PRODUCT wire form: `canonicalWireMessage`
//      (local-runtime-v2 context-wire.ts:1073) projects an assistant message
//      to `{role, content, timestamp}` ONLY — no provider/model/usage — so a
//      wire entry folds NO billing (documented expectation, verified against
//      the writer's code): assistant spend on the product seam rides the
//      turn-loop/branch writers, deferred W06/W07 (state/w05.md, "V-U02
//      writer deferral").
//
// The flat spelling stays a supported fallback (usage-pi-axes.test.ts folds
// it) — this suite pins the forms production actually writes.

import { describe, expect, it } from 'vitest';

import { fileURLToPath } from 'node:url';

import { buildProjection } from '../../src/index.js';
import type { Entry, JsonValue } from '../../../durable-backend-sqlite-zstd/src/types.js';
import { llmEntry } from './helpers.js';

type PiEntry = Record<string, unknown>;
interface PiBreakdownRow {
	key: string;
	cost: number;
	tokens: number;
}

// The pinned pi usage-totals (vendored dist, NOT our code) — same oracle as
// usage-pi-axes.test.ts.
const PI_CORE = fileURLToPath(
	new URL('../../../../third_party/pi-mono/packages/coding-agent/src/core', import.meta.url),
);

async function loadPi(): Promise<(entries: PiEntry[]) => PiBreakdownRow[]> {
	const usageTotals = (await import(`${PI_CORE}/usage-totals.ts`)) as {
		getUsageCostBreakdown: (entries: PiEntry[]) => PiBreakdownRow[];
	};
	return usageTotals.getUsageCostBreakdown;
}

/**
 * The donor's AssistantMessage, field-complete per pi-ai `types.ts:570-601`:
 * every field `appendAssistant`'s callers put on it rides the record — the
 * usage block is the FULL `Usage` shape (pi-ai types.ts:451-472) including
 * the optional `cacheWrite1h`/`reasoning` splits.
 */
const DONOR_ASSISTANT_MESSAGE = {
	role: 'assistant',
	content: [
		{ type: 'thinking', thinking: 'plan first', signature: 'sig-1' },
		{ type: 'text', text: 'here is the answer' },
	],
	api: 'anthropic',
	provider: 'anthropic',
	model: 'claude-virtual',
	// The provider resolved the virtual id to a concrete model — the pin bills
	// the concrete one (usage-totals `responseModel ?? model`).
	responseModel: 'claude-3-7-sonnet',
	responseId: 'msg_01ABC',
	usage: {
		input: 1200,
		output: 300,
		cacheRead: 8000,
		cacheWrite: 500,
		cacheWrite1h: 64,
		reasoning: 96,
		totalTokens: 10_000,
		cost: {
			input: 0.0036,
			output: 0.00225,
			cacheRead: 0.0064,
			cacheWrite: 0.000625,
			total: 0.012875,
		},
	},
	stopReason: 'stop',
	timestamp: 1_761_289_200_000,
	durationMs: 4321,
} as const;

/** The donor's stored record: `EntryRecord` with the top-level `model` array. */
function donorEntryRecord(): Record<string, unknown> {
	return {
		id: 101,
		conversationId: 'root',
		kind: 'pi.assistant',
		model: [DONOR_ASSISTANT_MESSAGE],
	};
}

/** Fold expectation shared by every donor-derived spelling. */
function expectDonorFold(manifest: ReturnType<typeof buildProjection>): void {
	const bucket = manifest.usage?.models['anthropic/claude-3-7-sonnet'];
	expect(bucket).toBeDefined();
	// The full counter set survived the record: required counters…
	expect(bucket).toMatchObject({
		input: 1200,
		output: 300,
		cacheRead: 8000,
		cacheWrite: 500,
		totalTokens: 10_000,
	});
	// …and the optional splits materialize (durable addUsage arithmetic).
	expect(bucket?.cacheWrite1h).toBe(64);
	expect(bucket?.reasoning).toBe(96);
	expect(bucket?.cost.total).toBeCloseTo(0.012875, 12);
	// Billing never invents context: the record is ONE segment.
	expect(manifest.segments).toHaveLength(1);
}

describe('the DONOR record form (pi-durable appendAssistant)', () => {
	it('folds the EntryRecord the donor actually stores (top-level model array, full AssistantMessage)', async () => {
		const pi = await loadPi();
		// The record as the donor's own log readers hand it to a projection:
		// kind `pi.assistant`, payload = the EntryRecord fields.
		const entry = llmEntry(
			'pi.assistant',
			donorEntryRecord() as unknown as JsonValue,
			1,
			0,
		);
		const manifest = buildProjection([entry]);
		expectDonorFold(manifest);

		// Parity with the pin: pi's usage-totals reads the same message
		// (keyed provider/responseModel ?? model) — cost and token row agree.
		const rows = await pi([
			{
				type: 'message',
				id: 'e1',
				parentId: null,
				timestamp: '1970-01-01T00:00:00.000Z',
				message: { ...DONOR_ASSISTANT_MESSAGE, timestamp: 0 },
			},
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.key).toBe('anthropic/claude-3-7-sonnet');
		expect(bucketCost(manifest)).toBeCloseTo(rows[0]!.cost, 10);
		expect(bucketTokens(manifest)).toBe(rows[0]!.tokens);
	});

	it('without responseModel the requested model is the billing key (pin fallback)', () => {
		const message = { ...DONOR_ASSISTANT_MESSAGE, responseModel: undefined };
		delete (message as Record<string, unknown>).responseModel;
		const manifest = buildProjection([
			llmEntry('pi.assistant', { id: 101, conversationId: 'root', kind: 'pi.assistant', model: [message] } as unknown as JsonValue, 1, 0),
		]);
		expect(manifest.usage?.models['anthropic/claude-virtual']?.input).toBe(1200);
		expect(manifest.usage?.models['anthropic/claude-3-7-sonnet']).toBeUndefined();
	});
});

describe('OUR W02 adapter wrapping (pi.record over the EntryRecord)', () => {
	it('the pi.record envelope folds the assistant record it wraps — verbatim payload', async () => {
		// Exactly what pi-storage.ts:881-886 appends for an 'entry' write:
		// { id: piImmutableEntryId('entry', record.id), kind: 'pi.record',
		//   payload: record }.
		const record = donorEntryRecord();
		const wire: Entry = {
			id: `pi.entry.${String(record.id)}`,
			parentId: null,
			kind: 'pi.record',
			payload: record as unknown as JsonValue,
			seq: 1 as Entry['seq'],
			ordinal: 0,
		};
		const manifest = buildProjection([wire]);
		expectDonorFold(manifest);

		// The adapter-spelled record folds IDENTICALLY to the donor-native
		// spelling — one billing axis, every durable form of the same message.
		const native = buildProjection([
			llmEntry('pi.assistant', record as unknown as JsonValue, 1, 0),
		]);
		expect(manifest.usage).toEqual(native.usage);
	});

	it('a pi.record wrapping a NON-assistant entry folds nothing (no user/tool billing inline)', () => {
		const userRecord = {
			id: 102,
			conversationId: 'root',
			kind: 'pi.user',
			model: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
		};
		const manifest = buildProjection([
			{
				id: 'pi.entry.102',
				parentId: null,
				kind: 'pi.record',
				payload: userRecord as unknown as JsonValue,
				seq: 1 as Entry['seq'],
				ordinal: 0,
			},
		]);
		expect(manifest.usage).toBeUndefined();
	});
});

describe('the PRODUCT wire form (context-wire canonicalWireMessage)', () => {
	it('folds NO billing — the wire writer projects role/content/timestamp only (documented undefined)', () => {
		// canonicalWireMessage (context-wire.ts:1073) output for an assistant
		// message: { role, content, timestamp } — verified against the
		// writer's code: no provider/model/usage ever travels. The wire entry
		// kind is 'session.message' (context-wire.ts:1040) and the payload is
		// { model: [wireMessage] } (entryOf, context-wire.ts:1053).
		const wireAssistant = {
			role: 'assistant',
			content: [{ type: 'text', text: 'the answer, projected for the wire' }],
			timestamp: 1_761_289_200_000,
		};
		const manifest = buildProjection([
			llmEntry('session.message', { model: [wireAssistant] } as unknown as JsonValue, 1, 0),
		]);
		// Documented expectation: undefined — the product wire seam strips
		// billing fields by design (only "provider-relevant fields travel"),
		// so assistant spend on that seam persists only through the W06/W07
		// writers (state/w05.md, "V-U02 writer deferral"). The entry itself
		// stays a perfectly normal context segment.
		expect(manifest.usage).toBeUndefined();
		expect(manifest.segments).toHaveLength(1);
	});
});

function bucketCost(manifest: ReturnType<typeof buildProjection>): number {
	return manifest.usage!.models['anthropic/claude-3-7-sonnet']!.cost.total;
}

function bucketTokens(manifest: ReturnType<typeof buildProjection>): number {
	const bucket = manifest.usage!.models['anthropic/claude-3-7-sonnet']!;
	return bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
}
