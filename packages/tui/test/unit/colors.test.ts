// Port of the pin's packages/tui/test/colors.test.ts (color parsing, OKLCH gamut mapping,
// OKHSL round-trip, styleText) onto the MCode engine barrel, plus coverage for the
// colorToOklch/mixColors exports the pin surface adds. Product theming stays ANSI16/hex (W10+).
import { describe, expect, it } from 'vitest';
import {
	colorToHex,
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	indexedColor,
	mixColors,
	okhslColor,
	oklchColor,
	parseColor,
	rgbColor,
	styleText,
} from '../../src/tui/engine/index.js';

describe('colors', () => {
	it('parses hex and OKLCH colors and rejects everything else', () => {
		expect(parseColor('#abc')).toStrictEqual({ kind: 'rgb', r: 170, g: 187, b: 204 });
		expect(parseColor('oklch(62% 0.1 200)')).toStrictEqual({ kind: 'oklch', l: 0.62, c: 0.1, h: 200 });
		expect(() => parseColor('')).toThrow(/Invalid color value/);
		expect(() => parseColor('red')).toThrow(/Invalid color value/);
	});

	it('gamut-maps OKLCH to sRGB, including the lightness limits', () => {
		expect(colorToRgb(oklchColor(0.627955, 0.257683, 29.2339))).toStrictEqual({ r: 255, g: 0, b: 0 });
		expect(colorToRgb(oklchColor(1, 0.3, 150))).toStrictEqual({ r: 255, g: 255, b: 255 });
		expect(colorToRgb(oklchColor(0, 0.3, 150))).toStrictEqual({ r: 0, g: 0, b: 0 });
	});

	it('parses OKHSL colors and round-trips them', () => {
		// Full saturation at the red cusp is pure sRGB red.
		expect(parseColor('okhsl(29.23 100% 56.8%)')).toStrictEqual(rgbColor(255, 0, 0));
		expect(parseColor('OKHSL(250deg 60% 55%)')).toStrictEqual(okhslColor(250, 0.6, 0.55));
		expect(() => parseColor('okhsl(250 160% 55%)')).toThrow(/s must be between 0 and 1/);
		for (const hex of ['#4f8eb3', '#20242a', '#f8f9fa']) {
			const { h, s, l } = colorToOkhsl(parseColor(hex));
			expect(colorToHex(okhslColor(h, s, l))).toBe(hex);
		}
	});

	it('styles text and closes sequences in reverse order', () => {
		expect(
			styleText('Ready', { fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true }, 'truecolor'),
		).toBe('\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m');
		expect(styleText('Ready', { fg: rgbColor(18, 52, 86) }, '256color')).toMatch(/^\x1b\[38;5;\d+mReady\x1b\[39m$/);
	});

	it('round-trips colorToOklch and mixes colors in both supported spaces', () => {
		const { l, c, h } = colorToOklch(rgbColor(255, 0, 0));
		expect(l).toBeCloseTo(0.627955, 3);
		expect(c).toBeCloseTo(0.257683, 3);
		expect(h).toBeCloseTo(29.2339, 1);
		// Default mix space is OKLCH; sRGB mixing is linear and yields a different midpoint
		// (sRGB mixing keeps fractional channels until conversion).
		const oklchMid = mixColors(rgbColor(255, 0, 0), rgbColor(0, 0, 255), 0.5);
		const srgbMid = mixColors(rgbColor(255, 0, 0), rgbColor(0, 0, 255), 0.5, 'srgb');
		expect(oklchMid).toStrictEqual(mixColors(rgbColor(255, 0, 0), rgbColor(0, 0, 255), 0.5, 'oklch'));
		expect(srgbMid).toStrictEqual({ kind: 'rgb', r: 127.5, g: 0, b: 127.5 });
		expect(colorToRgb(srgbMid)).not.toStrictEqual(colorToRgb(oklchMid));
	});
});
