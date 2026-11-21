import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessTerminal } from "../../src/tui/engine/public.js";
import {
	TuiFrameTracer,
	createTuiFrameTracerFromEnv,
	type TuiTraceRecord,
} from "../../src/tui/engine/tui-trace.js";

async function makeTraceDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "mcode-tui-trace-"));
}

async function readRecords(path: string): Promise<TuiTraceRecord[]> {
	const content = await readFile(path, "utf8");
	return content
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as TuiTraceRecord);
}

/** Poll until the file holds the final `close` record (close() flushes asynchronously). */
async function readClosedRecords(path: string): Promise<TuiTraceRecord[]> {
	const deadline = Date.now() + 2_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const records = await readRecords(path);
			if (records.at(-1)?.kind === "close") return records;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`sidecar never reached a close record: ${String(lastError)}`);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("TuiFrameTracer", () => {
	it("records frame boundaries with accumulated frame bytes and monotonic seq", async () => {
		const dir = await makeTraceDir();
		const path = join(dir, "trace.jsonl");
		const tracer = new TuiFrameTracer({ path, now: () => 1234, monoNs: () => "42" });

		tracer.beginFrame(); // frame 1 opens
		tracer.onWrite(10);
		tracer.onWrite(5);
		tracer.endFrame(); // frame 1 closes with 15 bytes
		tracer.onWrite(7); // outside any frame -> write record
		tracer.beginFrame(); // frame 2 opens
		tracer.endFrame(); // frame 2 closes with 0 bytes
		await tracer.close();

		const records = await readRecords(path);
		expect(records.map((record) => record.kind)).toEqual([
			"open",
			"frame.begin",
			"frame.end",
			"write",
			"frame.begin",
			"frame.end",
			"close",
		]);
		expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(records.map((record) => record.frameNo)).toEqual([0, 1, 1, 1, 2, 2, 2]);
		expect(records.map((record) => record.bytes)).toEqual([0, 0, 15, 7, 0, 0, 0]);
		for (const record of records) {
			expect(record.ts).toBe(1234);
			expect(record.monoNs).toBe("42");
		}
		await rm(dir, { recursive: true, force: true });
	});

	it("drops records with an explicit drop marker instead of blocking when the queue budget is exhausted", async () => {
		const dir = await makeTraceDir();
		const path = join(dir, "trace.jsonl");
		const tracer = new TuiFrameTracer({
			path,
			maxQueueBytes: 200,
			now: () => 0,
			monoNs: () => "0",
		});

		for (let i = 0; i < 50; i += 1) tracer.onWrite(1);
		await tracer.close();

		const records = await readRecords(path);
		const drops = records.filter((record) => record.kind === "drop");
		// 1 open + 50 writes + 1 close were produced; everything above the
		// budget is summarized by exactly one drop record.
		expect(drops).toHaveLength(1);
		const dropped = drops[0]!.bytes;
		expect(dropped).toBeGreaterThan(0);
		expect(dropped).toBe(53 - records.length);
		expect(records.at(-1)?.kind).toBe("close");
		await rm(dir, { recursive: true, force: true });
	});

	it("creates the sidecar directory lazily on flush", async () => {
		const dir = await makeTraceDir();
		const path = join(dir, "missing", "trace.jsonl");
		const tracer = new TuiFrameTracer({
			path,
			now: () => 0,
			monoNs: () => "0",
			flushIntervalMs: 5,
		});

		// The directory is created lazily by the sink, so this must succeed.
		tracer.onWrite(3);
		await tracer.flush();
		let records = await readRecords(path);
		expect(records.map((record) => record.kind)).toEqual(["open", "write"]);

		tracer.onWrite(4);
		await tracer.close();
		records = await readRecords(path);
		// Every outside-frame write is one record (1:1, like the first flush
		// above); close appends the final marker without losing the second write.
		expect(records.map((record) => record.kind)).toEqual(["open", "write", "write", "close"]);
		await rm(dir, { recursive: true, force: true });
	});

	it("ignores frames and writes after close", async () => {
		const dir = await makeTraceDir();
		const path = join(dir, "trace.jsonl");
		const tracer = new TuiFrameTracer({ path, now: () => 0, monoNs: () => "0" });
		await tracer.close();
		tracer.beginFrame();
		tracer.onWrite(9);
		tracer.endFrame();
		await tracer.flush();
		const records = await readRecords(path);
		expect(records.map((record) => record.kind)).toEqual(["open", "close"]);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("createTuiFrameTracerFromEnv", () => {
	it("is disabled without MCODE_TUI_TRACE", () => {
		expect(createTuiFrameTracerFromEnv({})).toBeUndefined();
		expect(createTuiFrameTracerFromEnv({ MCODE_TUI_TRACE: "   " })).toBeUndefined();
	});

	it("uses the configured path", async () => {
		const dir = await makeTraceDir();
		const path = join(dir, "trace.jsonl");
		const tracer = createTuiFrameTracerFromEnv({ MCODE_TUI_TRACE: path });
		expect(tracer?.path).toBe(path);
		await tracer?.close();
		const records = await readRecords(path);
		expect(records.map((record) => record.kind)).toEqual(["open", "close"]);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("ProcessTerminal MCODE_TUI_TRACE integration", () => {
	it("accounts write bytes per frame through traceFrameBegin/End", async () => {
		const dir = await makeTraceDir();
		const path = join(dir, "trace.jsonl");
		vi.stubEnv("MCODE_TUI_TRACE", path);
		const stdout = Object.assign(new PassThrough(), {
			isTTY: false,
			fd: 1,
			columns: 80,
			rows: 24,
		});
		vi.spyOn(stdout, "write").mockReturnValue(true);
		vi.spyOn(process, "stdout", "get").mockReturnValue(
			stdout as unknown as typeof process.stdout,
		);
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const stdin = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
		vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);

		const terminal = new ProcessTerminal();
		terminal.traceFrameBegin();
		terminal.write("hello");
		terminal.traceFrameEnd();
		terminal.write("outside");
		terminal.stop();

		const records = await readClosedRecords(path);
		expect(records[0]?.kind).toBe("open");
		expect(records[1]).toMatchObject({ kind: "frame.begin", frameNo: 1, bytes: 0 });
		expect(records[2]).toMatchObject({
			kind: "frame.end",
			frameNo: 1,
			bytes: Buffer.byteLength("hello", "utf8"),
		});
		// `outside` plus the shutdown control writes; all outside any frame.
		const outsideWrites = records.slice(3, -1);
		expect(outsideWrites.length).toBeGreaterThanOrEqual(1);
		expect(outsideWrites[0]).toMatchObject({
			kind: "write",
			frameNo: 1,
			bytes: Buffer.byteLength("outside", "utf8"),
		});
		for (const record of outsideWrites.slice(1)) expect(record.kind).toBe("write");
		expect(records.at(-1)?.kind).toBe("close");
		await rm(dir, { recursive: true, force: true });
	});
});
