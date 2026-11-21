import { describe, expect, it } from 'vitest';
import {
	extractOsc11BackgroundColorResponse,
	extractOscColorResponse,
	extractTerminalColorSchemeReport,
} from '../../src/tui/engine/terminal-colors.js';
import {
	type Component,
	type Terminal,
	TuiMainScreen,
	type TUI,
} from '../../src/tui/engine/index.js';

// L023 regression: terminals answer color queries and push DEC 2031 reports
// asynchronously, so replies arrive coalesced with unrelated input inside one
// read chunk. The chunk-internal extractors must locate each sequence anywhere
// in the chunk and return the remaining bytes so they stay dispatchable.

describe('extractOscColorResponse', () => {
	it('extracts an OSC 10/11/4 reply from the middle of a chunk and keeps the rest', () => {
		const extracted = extractOscColorResponse('abc\x1b]10;rgb:ffff/ffff/ffff\x07def');
		expect(extracted).toEqual({
			value: { target: 'foreground', rgb: { r: 255, g: 255, b: 255 } },
			rest: 'abcdef',
		});
	});

	it('extracts palette and background replies with either terminator', () => {
		expect(extractOscColorResponse('x\x1b]4;13;#ff0080\x1b\\y')).toEqual({
			value: { target: 13, rgb: { r: 255, g: 0, b: 128 } },
			rest: 'xy',
		});
		expect(extractOscColorResponse('\x1b]11;#000000\x07')).toEqual({
			value: { target: 'background', rgb: { r: 0, g: 0, b: 0 } },
			rest: '',
		});
	});

	it('reports unparseable colors and ignores chunks without a color reply', () => {
		expect(extractOscColorResponse('x\x1b]4;1;bogus\x07')).toEqual({
			value: { target: 1, rgb: undefined },
			rest: 'x',
		});
		expect(extractOscColorResponse('plain input \x1b[A more')).toBeUndefined();
		expect(extractOscColorResponse('\x1b]12;#ffffff\x07')).toBeUndefined();
	});

	it('extracts only the first reply; repeated extraction drains the chunk', () => {
		const first = extractOscColorResponse('\x1b]10;#ffffff\x07k\x1b]11;#000000\x07');
		expect(first?.value.target).toBe('foreground');
		expect(first?.rest).toBe('k\x1b]11;#000000\x07');
		const second = extractOscColorResponse(first!.rest);
		expect(second).toEqual({
			value: { target: 'background', rgb: { r: 0, g: 0, b: 0 } },
			rest: 'k',
		});
	});
});

describe('extractTerminalColorSchemeReport', () => {
	it('extracts a DEC 2031 report from the middle of a chunk and keeps the rest', () => {
		expect(extractTerminalColorSchemeReport('x\x1b[?997;1ny')).toEqual({ value: 'dark', rest: 'xy' });
		expect(extractTerminalColorSchemeReport('\x1b[?997;2n')).toEqual({ value: 'light', rest: '' });
	});

	it('removes every report and lets the last one win', () => {
		expect(extractTerminalColorSchemeReport('a\x1b[?997;2nb\x1b[?997;1nc\x1b[?997;1nd')).toEqual({
			value: 'dark',
			rest: 'abcd',
		});
	});

	it('ignores other report kinds and mixed prefixes', () => {
		expect(extractTerminalColorSchemeReport('\x1b[?997;3n')).toBeUndefined();
		expect(extractTerminalColorSchemeReport('\x1b[?996n')).toBeUndefined();
	});

	it('keeps the legacy OSC 11 background extractor working', () => {
		expect(extractOsc11BackgroundColorResponse('k\x1b]11;#101010\x07')).toEqual({
			value: { r: 16, g: 16, b: 16 },
			rest: 'k',
		});
		expect(extractOsc11BackgroundColorResponse('k\x1b]10;#101010\x07')).toBeUndefined();
	});
});

class ColorQueryTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	readonly writes: string[] = [];

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(): void {}

	setProgress(): void {}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	sendResize(): void {
		this.resizeHandler?.();
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

describe('TuiMainScreen chunk-internal color consumption (L023)', () => {
	it('settles a pending query from a reply sharing one chunk with a key, and dispatches the key', async () => {
		const terminal = new ColorQueryTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			// One read chunk: a key, then the OSC 10 reply, then a scheme report.
			terminal.sendInput('x\x1b]10;#ffffff\x07\x1b[?997;2n');
			// An anchored DA1 reply in its own chunk terminates the query without waiting for the timeout.
			terminal.sendInput('\x1b[?62;22c');
			const colors = await query;
			expect(colors.foreground).toEqual({ r: 255, g: 255, b: 255 });
			expect(component.inputs).toEqual(['x']);
		} finally {
			tui.stop();
		}
	});

	it('forwards an extracted DEC 2031 report to scheme listeners and dispatches the remaining key', async () => {
		const terminal = new ColorQueryTerminal();
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputRecorder();
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const schemes: string[] = [];
		const unsubscribe = tui.onTerminalColorSchemeChange((scheme) => schemes.push(scheme));
		try {
			terminal.sendInput('y\x1b[?997;1n');
			expect(component.inputs).toEqual(['y']);
			expect(schemes).toEqual(['dark']);
		} finally {
			unsubscribe();
			tui.stop();
		}
	});
});
