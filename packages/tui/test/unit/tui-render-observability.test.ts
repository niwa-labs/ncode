import { describe, expect, it, vi } from "vitest";
import { TuiBase } from "../../src/tui/engine/tui.js";
import { TuiMainScreen, type Component, type Terminal } from "../../src/tui/engine/public.js";
import type {
	TuiObservability,
	TuiRenderObservation,
	TuiRenderWaitObservation,
	TuiTranscriptPerformanceObservation,
} from "../../src/observability/local-observability.js";

function createObservability() {
	const observeRender = vi.fn<TuiObservability["observeRender"]>();
	const observeRenderWait = vi.fn<NonNullable<TuiObservability["observeRenderWait"]>>();
	const recordTranscriptPerformance =
		vi.fn<NonNullable<TuiObservability["recordTranscriptPerformance"]>>();
	const sink: TuiObservability = {
		recordStartup: vi.fn(),
		recordAccess: vi.fn(),
		recordEventStream: vi.fn(),
		recordTerminal: vi.fn(),
		recordProcessStop: vi.fn(),
		recordTheme: vi.fn(),
		observeRender,
		observeRenderWait,
		recordTranscriptPerformance,
		snapshot: vi.fn(),
		flush: vi.fn(async () => undefined),
	};
	return { ...sink, observeRender, observeRenderWait, recordTranscriptPerformance };
}

interface FakeTerminal extends Terminal {
	write: ReturnType<typeof vi.fn>;
	outputPending: boolean;
	drainOutput?: () => Promise<void>;
	traceFrameBegin: ReturnType<typeof vi.fn>;
	traceFrameEnd: ReturnType<typeof vi.fn>;
}

function createFakeTerminal(overrides: Partial<FakeTerminal> = {}): FakeTerminal {
	const terminal = {
		start: vi.fn(),
		stop: vi.fn(),
		drainInput: vi.fn(async () => undefined),
		write: vi.fn(),
		moveBy: vi.fn(),
		hideCursor: vi.fn(),
		showCursor: vi.fn(),
		clearLine: vi.fn(),
		clearFromCursor: vi.fn(),
		clearScreen: vi.fn(),
		setTitle: vi.fn(),
		setProgress: vi.fn(),
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		outputPending: false,
		traceFrameBegin: vi.fn(),
		traceFrameEnd: vi.fn(),
		...overrides,
	};
	return terminal as FakeTerminal;
}

/** TuiBase is abstract; renderFrame is exercised through renderNow(). */
class TestTui extends TuiBase {
	readonly mode = "regular" as const;
	renderCalls = 0;
	clock = 0;
	throwInDoRender = false;
	reportChangedLines = true;

	constructor(terminal: Terminal) {
		super(terminal);
	}

	protected nowMs(): number {
		return this.clock;
	}

	protected doRender(): void {
		this.renderCalls += 1;
		if (this.throwInDoRender) throw new Error("render failed");
		// Mirrors what TuiMainScreen/TuiAltScreen report for a changed frame.
		if (this.reportChangedLines) this.frameChangedLines = 3;
		this.terminal.write("frame");
	}
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("TuiBase render observability wiring", () => {
	it("reports render CPU duration, changed lines and the fullRedraw flag per frame", () => {
		const observability = createObservability();
		const terminal = createFakeTerminal();
		const tui = new TestTui(terminal);
		tui.setObservability(observability);

		tui.renderNow(true);
		expect(terminal.traceFrameBegin).toHaveBeenCalledTimes(1);
		expect(terminal.traceFrameEnd).toHaveBeenCalledTimes(1);
		const first = observability.observeRender.mock.calls[0]?.[0] as TuiRenderObservation;
		expect(first).toMatchObject({
			width: 80,
			height: 24,
			changedLines: 3,
			fullRedraw: false,
		});
		expect(first.durationMs).toBeGreaterThanOrEqual(0);

		// A frame that bumps fullRedrawCount reports fullRedraw: true.
		const nextFrame = new (class extends TestTui {
			protected override doRender(): void {
				this.renderCalls += 1;
				this.fullRedrawCount += 1;
				this.frameChangedLines = 24;
				this.terminal.write("replay");
			}
		})(terminal);
		nextFrame.setObservability(observability);
		nextFrame.renderNow(true);
		const second = observability.observeRender.mock.calls[1]?.[0] as TuiRenderObservation;
		expect(second).toMatchObject({ changedLines: 24, fullRedraw: true });
	});

	it("resets changedLines to zero when the subclass reports nothing", () => {
		const observability = createObservability();
		const tui = new TestTui(createFakeTerminal());
		tui.setObservability(observability);
		tui.reportChangedLines = false;
		tui.renderNow(true);
		expect(observability.observeRender.mock.calls[0]?.[0]).toMatchObject({ changedLines: 0 });
	});

	it("does not observe a render when the frame is deferred behind output drain, and records the drain wait separately", async () => {
		const observability = createObservability();
		let resolveDrain: (() => void) | undefined;
		const terminal = createFakeTerminal({
			outputPending: true,
			drainOutput: () =>
				new Promise<void>((resolve) => {
					resolveDrain = resolve;
				}),
		});
		const tui = new TestTui(terminal);
		tui.setObservability(observability);

		tui.renderNow(true); // First frame renders normally (frame 1).
		expect(tui.renderCalls).toBe(1);
		expect(observability.observeRender).toHaveBeenCalledTimes(1);

		tui.renderNow(); // Output still pending: deferred, no CPU render observed.
		expect(tui.renderCalls).toBe(1);
		expect(observability.observeRender).toHaveBeenCalledTimes(1);
		expect(observability.observeRenderWait).not.toHaveBeenCalled();

		tui.clock += 5;
		resolveDrain?.();
		await flushMicrotasks();
		expect(observability.observeRenderWait).toHaveBeenCalledTimes(1);
		const wait = observability.observeRenderWait.mock.calls[0]?.[0] as TuiRenderWaitObservation;
		expect(wait).toMatchObject({ durationMs: 5, frame: 1 });
	});

	it("still closes the trace frame when doRender throws", () => {
		const observability = createObservability();
		const terminal = createFakeTerminal();
		const tui = new TestTui(terminal);
		tui.setObservability(observability);
		tui.throwInDoRender = true;
		expect(() => tui.renderNow(true)).toThrow("render failed");
		expect(terminal.traceFrameBegin).toHaveBeenCalledTimes(1);
		expect(terminal.traceFrameEnd).toHaveBeenCalledTimes(1);
		expect(observability.observeRender).not.toHaveBeenCalled();
	});

	it("records the transcript performance snapshot at most once per interval", () => {
		const observability = createObservability();
		const tui = new TestTui(createFakeTerminal());
		tui.setObservability(observability);
		const snapshot = {
			sourceUnits: 10,
			projectedCells: 900,
			projectedUnits: 12,
			renderedUnits: 11,
			hiddenTurns: 0,
			foldedCells: 2,
			projectionVisitedCells: 950,
			windowRolls: 3,
			unitCacheEntries: 40,
			unitCacheHits: 300,
			unitCacheMisses: 9,
		};
		tui.setTranscriptPerformanceProvider(() => snapshot);

		tui.renderNow(true); // First frame records immediately.
		expect(observability.recordTranscriptPerformance).toHaveBeenCalledTimes(1);
		const first =
			observability.recordTranscriptPerformance.mock.calls[0]?.[0] as TuiTranscriptPerformanceObservation;
		expect(first).toMatchObject({ frame: 1, snapshot });

		tui.clock += 500;
		tui.renderNow(); // Inside the 1 s interval: not recorded again.
		expect(observability.recordTranscriptPerformance).toHaveBeenCalledTimes(1);

		tui.clock += 1_000;
		tui.renderNow();
		expect(observability.recordTranscriptPerformance).toHaveBeenCalledTimes(2);
		expect(
			(observability.recordTranscriptPerformance.mock.calls[1]?.[0] as TuiTranscriptPerformanceObservation)
				.frame,
		).toBe(3);
	});

	it("skips the transcript snapshot without a provider", () => {
		const observability = createObservability();
		const tui = new TestTui(createFakeTerminal());
		tui.setObservability(observability);
		tui.renderNow(true);
		expect(observability.recordTranscriptPerformance).not.toHaveBeenCalled();
	});
});

describe("TuiMainScreen render observability wiring", () => {
	class FixedLines implements Component {
		lines: string[];
		constructor(lines: string[]) {
			this.lines = lines;
		}
		render(): string[] {
			return [...this.lines];
		}
		invalidate(): void {}
	}

	it("derives changedLines and the fullRedraw flag from the actual line diff", () => {
		const observability = createObservability();
		const tui = new TuiMainScreen(createFakeTerminal());
		tui.setObservability(observability);
		const content = new FixedLines(["alpha", "beta"]);
		tui.addChild(content);

		tui.renderNow(true); // First render repaints the whole document.
		expect(observability.observeRender.mock.calls[0]?.[0]).toMatchObject({
			changedLines: 2,
			fullRedraw: true,
			width: 80,
			height: 24,
		});

		content.lines = ["alpha", "beta2"];
		tui.renderNow(); // Single-row diff, no reconstruction.
		expect(observability.observeRender.mock.calls[1]?.[0]).toMatchObject({
			changedLines: 1,
			fullRedraw: false,
		});

		content.lines = ["alpha", "beta2", "gamma"];
		tui.renderNow(); // Appended rows count as changed.
		expect(observability.observeRender.mock.calls[2]?.[0]).toMatchObject({
			changedLines: 1,
			fullRedraw: false,
		});
	});
});
