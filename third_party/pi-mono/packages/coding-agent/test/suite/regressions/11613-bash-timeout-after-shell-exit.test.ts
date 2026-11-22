import { type ChildProcess, spawn } from "child_process";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../../src/core/tools/bash.ts";

vi.mock("child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("child_process")>();
	return { ...original, spawn: vi.fn(original.spawn) };
});

/**
 * The shell's exit can precede the command deadline while a descendant keeps stdout
 * open. In that case the timeout reports the shell's exit code (#11613).
 */
describe.skipIf(process.platform === "win32")("issue #11613 bash timeout after the shell exited", () => {
	const bashTool = createBashTool(tmpdir(), {
		output: { strategy: "head_tail", persistOutput: false },
	});

	it("reports the shell's exit code when background processes kept writing until the timeout", async ({ onTestFinished }) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const { promise: outputAfterExit, resolve: resolveOutputAfterExit } = Promise.withResolvers<void>();
		const controller = new AbortController();
		const spawnMock = vi.mocked(spawn);
		onTestFinished(() => {
			controller.abort();
			spawnMock.mockReset();
			vi.useRealTimers();
		});
		const realSpawn = spawnMock.getMockImplementation()!;
		spawnMock.mockImplementationOnce((...args) => {
			const child: ChildProcess = realSpawn(...args);
			// Leave less than the pipe idle grace before the command deadline.
			// Node emits spawn before exit, and the backend has armed its timer by then.
			child.once("spawn", () => vi.advanceTimersByTime(950));
			child.once("exit", () => {
				child.stdout?.once("data", () => resolveOutputAfterExit());
			});
			return child;
		});
		const execution = bashTool.execute(
			"test-11613",
			{ command: "echo boom >&2; (while :; do echo tick; sleep 0.05; done) & exit 3", timeout: 1 },
			controller.signal,
		);
		// Keep the real shell and inherited stdout, but control when the deadline
		// fires so startup or exit notification can take as long as needed.
		await Promise.race([outputAfterExit, execution]);
		await vi.advanceTimersByTimeAsync(50);
		const failure = await execution.then(() => undefined, (error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain("boom");
		expect(message).toContain("tick");
		expect(message).toMatch(
			/Command timed out after 1 seconds\. The shell exited with code 3 after \d+(?:\.\d+)? seconds, but background processes it started kept writing output until the timeout\.$/,
		);
	});

	it("keeps the plain timeout message when the shell was still running at the deadline", async () => {
		const error = await bashTool.execute("test-11613", { command: "echo started; sleep 30", timeout: 0.3 }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/started\s+Command timed out after 0\.3 seconds$/);
	});
});
