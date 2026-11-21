// Port of the pin's packages/tui/test/terminal-colors.test.ts (terminal color queries over the
// pin color-query system) onto the MCode engine barrel and vitest. The MCode L023 chunk-internal
// extraction has its own dedicated regression in tui-terminal-color-sequences.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type Component,
	parseOscColorResponse,
	parseTerminalColorSchemeReport,
	type Terminal,
	type TerminalColors,
	type TUI,
	TuiMainScreen,
} from '../../src/tui/engine/index.js';
import { StdinBuffer } from '../../src/tui/engine/stdin-buffer.js';

class TestTerminal implements Terminal {
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

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
	vi.useRealTimers();
});

describe('parseTerminalColorSchemeReport', () => {
	it('parses color scheme reports', () => {
		expect(parseTerminalColorSchemeReport('\x1b[?997;1n')).toBe('dark');
		expect(parseTerminalColorSchemeReport('\x1b[?997;2n')).toBe('light');
		expect(parseTerminalColorSchemeReport('\x1b[?997;2n\x1b[?997;1n\x1b[?997;1n')).toBe('dark');
		expect(parseTerminalColorSchemeReport('\x1b[?997;1n\x1b[?997;2n\x1b[?997;2n')).toBe('light');
		expect(parseTerminalColorSchemeReport('\x1b[?997;3n')).toBeUndefined();
		expect(parseTerminalColorSchemeReport('\x1b[?996n')).toBeUndefined();
		expect(parseTerminalColorSchemeReport('x\x1b[?997;1n')).toBeUndefined();
	});
});

describe('parseOscColorResponse', () => {
	it('parses OSC 10, 11, and 4 replies', () => {
		expect(parseOscColorResponse('\x1b]10;rgb:ffff/ffff/ffff\x07')).toStrictEqual({
			target: 'foreground',
			rgb: { r: 255, g: 255, b: 255 },
		});
		expect(parseOscColorResponse('\x1b]4;13;#ff0080\x1b\\')).toStrictEqual({
			target: 13,
			rgb: { r: 255, g: 0, b: 128 },
		});
		expect(parseOscColorResponse('\x1b]4;1;bogus\x07')).toStrictEqual({ target: 1, rgb: undefined });
		expect(parseOscColorResponse('\x1b]12;#ffffff\x07')).toBeUndefined();
	});
});

const PALETTE_REPLIES = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};#000000\x07`);
const DA1 = '\x1b[?62;22c';
const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

function setup(): { terminal: TestTerminal; tui: TUI; component: InputRecorder } {
	const terminal = new TestTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	const component = new InputRecorder();
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	return { terminal, tui, component };
}

describe('TUI.queryTerminalColors', () => {
	it('queries all colors in one write and consumes the replies', async () => {
		const { terminal, tui, component } = setup();
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			const written = terminal.writes.at(-1) ?? '';
			expect(written.startsWith('\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07')).toBe(true);
			expect(written.endsWith('\x1b[c')).toBe(true);

			terminal.sendInput('x');
			terminal.sendInput('\x1b]10;#ffffff\x07');
			terminal.sendInput('\x1b]11;rgb:0000/0000/0000\x1b\\');
			for (const reply of PALETTE_REPLIES) terminal.sendInput(reply);
			// Resolves once every reply arrived, without waiting for DA1.
			expect(await query).toStrictEqual({
				foreground: WHITE,
				background: BLACK,
				palette: Array.from({ length: 16 }, () => BLACK),
			});
			terminal.sendInput(DA1);
			expect(component.inputs).toEqual(['x']);
		} finally {
			tui.stop();
		}
	});

	it('consumes delayed Ghostty color fragments without typing their tail or opening the editor', async () => {
		vi.useFakeTimers();
		const { terminal, tui, component } = setup();
		const buffer = new StdinBuffer();
		buffer.on('data', (data: string) => terminal.sendInput(data));
		try {
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			// Captured from Ghostty 1.3.1 with Ayu Light, split at the reported tail.
			buffer.process('\x1b]4;1;rgb:eaea/6c');
			vi.advanceTimersByTime(100);
			buffer.process(`6c/6d6d\x07${DA1}`);
			expect(await query).toStrictEqual({ foreground: undefined, background: undefined, palette: undefined });
			expect(component.inputs).toEqual([]);

			// A real Ctrl+G must still reach the editor after the reply.
			buffer.process('\x07');
			expect(component.inputs).toEqual(['\x07']);
		} finally {
			buffer.destroy();
			tui.stop();
		}
	});

	it('resolves on DA1 with the replies that arrived, in query order', async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			terminal.sendInput('\x1b]11;#000000\x07');
			// An incomplete palette is dropped.
			for (const reply of PALETTE_REPLIES.slice(0, 8)) terminal.sendInput(reply);
			terminal.sendInput(DA1);
			terminal.sendInput(DA1);

			expect(await first).toStrictEqual({ foreground: undefined, background: BLACK, palette: undefined });
			expect(await second).toStrictEqual({ foreground: undefined, background: undefined, palette: undefined });
		} finally {
			tui.stop();
		}
	});

	it('reports late replies after a timeout and consumes them until DA1', async () => {
		const { terminal, tui, component } = setup();
		try {
			const late: TerminalColors[] = [];
			const query = tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
			await wait(5);
			expect((await query).background).toBeUndefined();

			terminal.sendInput('\x1b]11;#ffffff\x07');
			terminal.sendInput(DA1);
			expect(late).toStrictEqual([{ foreground: undefined, background: WHITE, palette: undefined }]);
			expect(component.inputs).toEqual([]);

			// With no query pending, color replies are ordinary input again.
			terminal.sendInput('\x1b]11;#ffffff\x07');
			expect(component.inputs).toEqual(['\x1b]11;#ffffff\x07']);
		} finally {
			tui.stop();
		}
	});
});
