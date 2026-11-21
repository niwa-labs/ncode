/**
 * W02 adapter usage round-trip (W05 review pass 2, remark 1): do
 * `provider`/`model`/`usage` actually reach the durable record the W02
 * pi-storage adapter writes — the record `@mavis/context-projection` folds
 * the inline assistant billing (pi shape (a)) from?
 *
 * The donor's `appendAssistant` (third_party/pi-durable
 * harness/generation.ts:743-750) stores an `EntryRecord` whose TOP-LEVEL
 * `model` field is the full pi-ai `AssistantMessage` (provider, model,
 * responseModel, usage). This suite writes that record through the REAL
 * adapter (`PiSqliteZstdStorage` over `SqliteZstdBackend`), reads the mcode
 * log back, and proves the projection folds the billing off it: the adapter
 * stores the record VERBATIM (pi-storage.ts:881-886 — payload is
 * `write.value` untouched), so nothing needs patching on the writer side.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { EntryId } from '@earendil-works/pi-durable';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { afterAll, describe, expect, it } from 'vitest';

import { PiSqliteZstdStorage, PI_RECORD_ENTRY_KIND, SqliteZstdBackend } from '../src/index.js';
import { buildProjection } from '../../context-projection/src/index.js';

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];

function freshDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'pi-storage-usage-'));
	directories.push(directory);
	return directory;
}

afterAll(() => {
	for (const directory of directories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort; the OS temp root wipes anyway.
		}
	}
});

/** The donor's AssistantMessage (pi-ai types.ts:570-601), usage-complete. */
const DONOR_MESSAGE = {
	role: 'assistant',
	content: [{ type: 'text', text: 'done' }],
	api: 'anthropic',
	provider: 'anthropic',
	model: 'claude-virtual',
	responseModel: 'claude-3-7-sonnet',
	usage: {
		input: 1200,
		output: 300,
		cacheRead: 8000,
		cacheWrite: 500,
		cacheWrite1h: 64,
		reasoning: 96,
		totalTokens: 10_000,
		cost: { input: 0.0036, output: 0.00225, cacheRead: 0.0064, cacheWrite: 0.000625, total: 0.012875 },
	},
	stopReason: 'stop',
	timestamp: 1_761_289_200_000,
	durationMs: 4321,
};

describe('pi-storage adapter: assistant billing reaches the durable record', () => {
	it('a donor-form assistant EntryRecord round-trips and folds in the projection', async () => {
		const directory = freshDirectory();
		const backend = SqliteZstdBackend.open(directory);
		const storage = PiSqliteZstdStorage.open(backend);
		await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context);
		const entryId = await storage.mintId<EntryId>();
		// EXACTLY the donor's appendAssistant write: the EntryRecord with the
		// top-level `model` array (generation.ts:749 → types.ts:428-443).
		await storage.commit(
			[
				{
					type: 'entry' as const,
					value: {
						id: entryId,
						conversationId: ROOT_CONVERSATION_ID,
						kind: 'pi.assistant',
						model: [DONOR_MESSAGE],
					},
				},
			],
			context,
		);

		const entries = backend.readDelta(0, 1024 * 1024);
		// The adapter wrapped the record as a pi.record entry with the
		// deterministic pi-domain id — payload VERBATIM.
		const assistantRecord = entries.find(
			(entry) =>
				entry.kind === PI_RECORD_ENTRY_KIND &&
				(entry.payload as { kind?: unknown } | null)?.kind === 'pi.assistant',
		);
		expect(assistantRecord).toBeDefined();
		expect(assistantRecord!.id).toBe(`pi.entry.${String(entryId)}`);
		const record = assistantRecord!.payload as {
			model: readonly [{ usage: typeof DONOR_MESSAGE.usage; provider: string; model: string; responseModel: string }];
		};
		// provider/model/usage flew through the adapter untouched.
		expect(record.model[0]!.provider).toBe('anthropic');
		expect(record.model[0]!.model).toBe('claude-virtual');
		expect(record.model[0]!.responseModel).toBe('claude-3-7-sonnet');
		expect(record.model[0]!.usage).toEqual(DONOR_MESSAGE.usage);

		// And the projection folds the billing off the durable log — the
		// responseModel billing key, every counter, both optional splits.
		const manifest = buildProjection(entries);
		const bucket = manifest.usage?.models['anthropic/claude-3-7-sonnet'];
		expect(bucket).toBeDefined();
		expect(bucket).toMatchObject({
			input: 1200,
			output: 300,
			cacheRead: 8000,
			cacheWrite: 500,
			totalTokens: 10_000,
		});
		expect(bucket?.cacheWrite1h).toBe(64);
		expect(bucket?.reasoning).toBe(96);
		expect(bucket?.cost.total).toBeCloseTo(0.012875, 12);

		await storage.close(context);
	});
});
