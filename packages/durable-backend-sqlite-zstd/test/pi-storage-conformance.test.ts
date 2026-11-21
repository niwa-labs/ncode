/**
 * W02 part A: the pinned upstream storage-conformance suite
 * (`@earendil-works/pi-durable/testing`, pin `48c8f3228`) run against OUR
 * full pi Storage adapter (`PiSqliteZstdStorage` over the sqlite-zstd
 * backend).
 *
 * This is the port plan's W02-T row "pi storage conformance против
 * memory/reference и sqlite-zstd": the SAME runner-independent cases upstream
 * runs against `MemoryStorage` and `SqliteStorage`, unmodified, over the
 * zstd-substrate adapter. Every case gets a fresh database directory, one
 * writable backend, one adapter; both close when the case ends.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { PiSqliteZstdStorage, SqliteZstdBackend } from '../src/index.js';

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];

afterAll(() => {
	for (const directory of directories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort: the OS temp root is wiped anyway.
		}
	}
});

registerStorageConformance({ describe, expect, it }, 'PiSqliteZstdStorage', async (use) => {
	const directory = mkdtempSync(join(tmpdir(), 'pi-storage-conformance-'));
	directories.push(directory);
	const backend = SqliteZstdBackend.open(directory);
	const storage = PiSqliteZstdStorage.open(backend);
	try {
		await use(storage);
	} finally {
		try {
			await storage.close(context);
		} finally {
			await backend.close();
		}
	}
});

// The suite registers its cases asynchronously at collection time; a trivial
// present test keeps vitest from treating this file as empty if upstream
// restructures registration.
describe('PiSqliteZstdStorage harness', () => {
	it('provides one fresh adapter per conformance case', () => {
		expect(PiSqliteZstdStorage).toBeTypeOf('function');
	});
});
