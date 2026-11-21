/**
 * W02-T / V-D03 (W02 share): the kill matrix over the PI record path.
 *
 * The existing `kill-9-crash.test.ts` proves the mcode commit path survives
 * SIGKILL; this file proves the same for the pi Storage adapter's commits —
 * the record families the full pi Storage persists (entries + task
 * replacements + the pi index rows) ride the same atomic backend commit, so:
 *
 * - every commit the child OBSERVED as resolved before the kill is durable
 *   and byte-identical after reopen (no loss);
 * - the durable state is a consistent prefix: every pi index row has its
 *   `pi.*` content entry in the log and vice versa (no half-applied commit,
 *   no orphan index row);
 * - the minted-ID watermark never dips below a committed id;
 * - after the kill a fresh writer takes over (stale owner pid detection) and
 *   the next commit takes the very next sequence — and re-committing an
 *   already-acked entry id is REJECTED (no duplicate effects on replay).
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID, type EntryId, type TaskId } from '@earendil-works/pi-durable';
import { loadSqlite3Constructor, PiSqliteZstdStorage, SqliteZstdBackend } from '../../src/index.js';
import { afterEach, describe, expect, it } from 'vitest';

const context = BACKGROUND_CONTEXT;
const Database = loadSqlite3Constructor();

const directories: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

function freshDirectory(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	for (const child of children.splice(0)) {
		try {
			child.kill('SIGKILL');
		} catch {
			// Already dead.
		}
	}
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

interface ChildProbe {
	child: ReturnType<typeof spawn>;
	exited: Promise<void>;
}

function spawnWriter(scriptPath: string, targetDir: string, progressFile: string): ChildProbe {
	const child = spawn(process.execPath, [scriptPath, targetDir, progressFile], {
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	const exited = new Promise<void>((resolve) => {
		child.on('exit', () => resolve());
	});
	children.push(child);
	return { child, exited };
}

async function waitForProgress(progressFile: string, count: number): Promise<string[]> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const lines = existsSafe(progressFile)
			? readFileSync(progressFile, 'utf8').split('\n').filter((line) => line.trim().length > 0)
			: [];
		if (lines.length >= count) return lines;
		if (Date.now() > deadline) throw new Error(`progress stalled at ${lines.length}/${count}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function existsSafe(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

describe('kill -9: pi Storage adapter commit path', () => {
	it('loses no observed pi commit, serves no half-applied state, and rejects replayed ids', async () => {
		const dir = freshDirectory('kill9-pi-storage-');
		const progressFile = join(dir, 'progress.jsonl');
		const scriptPath = join(dir, 'writer.mjs');
		writeWriterScript(scriptPath);

		const writer = spawnWriter(scriptPath, dir, progressFile);
		const lines = await waitForProgress(progressFile, 6);
		const observed = lines.map(
			(line) => JSON.parse(line) as { readonly i: number; readonly seq: number; readonly entryId: number; readonly taskId: number },
		);

		// Observe the durable head from OUTSIDE the writer, then -9 it.
		const raw = new Database(join(dir, 'sessions.g1.db'), { readonly: true, fileMustExist: true });
		const metaRows = raw.prepare("SELECT key, value FROM meta WHERE key IN ('head', 'pi.next_id')").all() as Array<{
			readonly key: string;
			readonly value: unknown;
		}>;
		raw.close();
		const durableHead = Number(metaRows.find((row) => row.key === 'head')?.value);
		const durableWatermark = Number(metaRows.find((row) => row.key === 'pi.next_id')?.value);
		writer.child.kill('SIGKILL');
		await writer.exited;

		expect(durableHead).toBeGreaterThanOrEqual(observed[observed.length - 1]!.seq);

		// Reopen over the killed writer's files: the stale owner pid must not
		// lock the generation out.
		const backend = SqliteZstdBackend.open(dir);
		expect(backend.head).toBeGreaterThanOrEqual(durableHead);
		const storage = PiSqliteZstdStorage.open(backend);

		// (1) No loss: every observed commit is readable byte-identically.
		const confirmed = observed.filter((item) => item.seq <= backend.head);
		expect(confirmed.length).toBeGreaterThanOrEqual(5);
		for (const item of confirmed) {
			const stored = await storage.entry(item.entryId as EntryId, context);
			expect(stored?.entry.kind).toBe('user');
			expect(stored?.entry.data).toEqual({ i: item.i });
			expect(stored?.commitSeq).toBe(item.seq);
		}
		// The task's LATEST committed replacement is readable; its status is
		// 'running' when any even iteration (observed or not) committed before
		// the kill — the exact last iteration is unknowable from outside, so
		// assert the durable record and its log-backed version below.
		const anyTask = observed[0]!;
		const task = await storage.task(anyTask.taskId as TaskId, context);
		expect(['pending', 'running']).toContain(task?.state.status);

		// (2) Consistent prefix: every pi index row has its zstd content entry.
		const sql = backend.recordIndexSql();
		const entryRows = sql.prepare('SELECT id, commit_seq FROM pi_entries ORDER BY id').all() as Array<{
			readonly id: number;
			readonly commit_seq: number;
		}>;
		expect(entryRows.length).toBeGreaterThan(0);
		const logEntries = backend.readDelta(0, 1024 * 1024 * 1024);
		const logIds = new Set(logEntries.map((logEntry) => logEntry.id));
		for (const row of entryRows) {
			expect(logIds.has(`pi.entry.${row.id}`)).toBe(true);
		}
		// And every task's LATEST version row points at real log content.
		const taskRows = sql.prepare('SELECT id, rev FROM pi_tasks').all() as Array<{ readonly id: number; readonly rev: number }>;
		for (const row of taskRows) {
			expect(logIds.has(`pi.task.${row.id}.r${row.rev}`)).toBe(true);
		}
		// The commit sequence served is a gap-free 1..head prefix.
		const seqs = new Set(logEntries.map((logEntry) => Number(logEntry.seq)));
		expect(seqs.size).toBe(Number(backend.head));

		// (3) The watermark never dips below a committed id.
		const committedIds = confirmed.map((item) => Math.max(item.entryId, item.taskId));
		const freshId = await storage.mintId<EntryId>();
		expect(freshId).toBeGreaterThanOrEqual(durableWatermark);
		expect(freshId).toBeGreaterThan(Math.max(...committedIds));

		// (4) No duplicate effects: replaying an already-acked entry id is
		// rejected (records are immutable), and a fresh write takes the very
		// next sequence.
		const replayed = confirmed[confirmed.length - 1]!;
		await expect(
			storage.commit(
				[
					{
						type: 'entry',
						value: { id: replayed.entryId as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: 'user' },
					},
				],
				context,
			),
		).rejects.toThrow(`ID ${replayed.entryId} already belongs to entry`);

		const nextSeq = await storage.commit(
			[
				{
					type: 'entry',
					value: { id: freshId, conversationId: ROOT_CONVERSATION_ID, kind: 'note' },
				},
			],
			context,
		);
		expect(nextSeq).toBe(backend.head); // head already advanced by this very commit
		expect(nextSeq).toBeGreaterThan(durableHead);
		await storage.close(context);
	}, 60_000);
});

/** Writer child: commits pi entries + task replacements as fast as it can. */
function writeWriterScript(scriptPath: string): void {
	const backendIndex = pathToFileURL(
		join(fileURLToDirname(import.meta.url), '../../src/index.ts'),
	).href;
	writeFileSync(
		scriptPath,
		`
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      try { return nextResolve(specifier, context); }
      catch { return nextResolve(specifier.replace(/\\.js$/, '.ts'), context); }
    }
    return nextResolve(specifier, context);
  },
});
const { SqliteZstdBackend, PiSqliteZstdStorage } = await import(${JSON.stringify(backendIndex)});
const [directory, progressFile] = process.argv.slice(2);
const backend = SqliteZstdBackend.open(directory);
const storage = PiSqliteZstdStorage.open(backend);
const context = { trace: { isSampled: false }, spans: [] };
const ROOT = 1;
await storage.commit([{ type: 'conversation', value: { id: ROOT } }], context);
const taskId = await storage.mintId();
const taskBase = (status) => ({
  id: taskId,
  conversationId: ROOT,
  kind: 'test.task',
  version: 1,
  input: {},
  state: { status, checkpoint: { phase: 'ready' } },
  background: false,
  abortRequested: false,
});
await storage.commit([{ type: 'task', value: taskBase('pending') }], context);
for (let i = 1; ; i += 1) {
  const entryId = await storage.mintId();
  const writes = [{ type: 'entry', value: { id: entryId, conversationId: ROOT, kind: 'user', data: { i } } }];
  if (i % 2 === 0) writes.push({ type: 'task', value: taskBase('running') });
  const seq = await storage.commit(writes, context);
  appendFileSync(progressFile, JSON.stringify({ i, seq: Number(seq), entryId: Number(entryId), taskId: Number(taskId) }) + '\\n');
}
`,
	);
}

function fileURLToDirname(url: string): string {
	return new URL('.', url).pathname;
}
