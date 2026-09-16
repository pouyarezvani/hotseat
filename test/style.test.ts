import { describe, expect, test } from 'bun:test';
import { meter } from '../src/ui/board.ts';
import { heading, pad, stripAnsi, type Theme, untilReset, visibleLength } from '../src/ui/style.ts';

const plain: Theme = { color: false, truecolor: false, unicode: true, width: 60 };
const ascii: Theme = { color: false, truecolor: false, unicode: false, width: 60 };
const colored: Theme = { color: true, truecolor: true, unicode: true, width: 60 };

describe('meter', () => {
	test('keeps one visual width for any percentage', () => {
		for (const percent of [0, 1, 33.3, 50, 99.9, 100]) {
			expect(visibleLength(meter(plain, percent, 14))).toBe(14);
		}
	});

	test('clamps out-of-range input instead of overflowing', () => {
		expect(visibleLength(meter(plain, 150, 10))).toBe(10);
		expect(visibleLength(meter(plain, -40, 10))).toBe(10);
	});

	test('shows something for a small non-zero reading', () => {
		expect(stripAnsi(meter(plain, 3, 14))).not.toBe('░'.repeat(14));
	});

	test('falls back to ascii where box drawing is unavailable', () => {
		expect(stripAnsi(meter(ascii, 50, 10))).toBe('#####.....');
	});

	test('measures width by what is visible, not by escape codes', () => {
		expect(visibleLength(meter(colored, 60, 14))).toBe(14);
		expect(stripAnsi(meter(colored, 60, 14)).length).toBeGreaterThan(0);
	});
});

describe('heading', () => {
	test('fills the terminal width with its rule', () => {
		expect(visibleLength(heading(plain, 'Claude'))).toBe(plain.width);
	});

	test('does not overflow when the title is nearly the whole width', () => {
		const long = 'x'.repeat(plain.width);
		expect(visibleLength(heading(plain, long))).toBeLessThanOrEqual(plain.width + 2);
	});
});

describe('pad', () => {
	test('pads by visible width so coloured labels still line up', () => {
		const label = '[31mab[39m';
		expect(visibleLength(pad(label, 6))).toBe(6);
	});
});

describe('untilReset', () => {
	const now = Date.parse('2026-09-16T12:00:00Z');

	test('formats minutes, hours and days', () => {
		expect(untilReset('2026-09-16T12:30:00Z', now)).toBe('30m');
		expect(untilReset('2026-09-16T15:20:00Z', now)).toBe('3h 20m');
		expect(untilReset('2026-09-19T14:00:00Z', now)).toBe('3d 2h');
	});

	test('never reports a negative window for a reset already past', () => {
		expect(untilReset('2026-09-15T12:00:00Z', now)).toBe('reset');
	});

	test('returns nothing for missing or unreadable input', () => {
		expect(untilReset(undefined, now)).toBe('');
		expect(untilReset('not-a-date', now)).toBe('');
	});
});
