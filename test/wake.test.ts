import { describe, expect, test } from 'bun:test';
import { awakeFrom } from '../src/core/wake.ts';

describe('telling a full wake from a half one', () => {
	test('a Mac with its screen system up is awake', () => {
		expect(
			awakeFrom(
				'Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n',
			),
		).toBe(true);
	});

	test('a Mac woken briefly with the lid closed is not', () => {
		expect(
			awakeFrom('Current System Capabilities are: CPU Network \nCurrent Power State: 4\n'),
		).toBe(false);
		expect(awakeFrom('Current System Capabilities are: CPU Audio Network \n')).toBe(false);
	});

	test('an answer it cannot read is taken as awake, so a missing tool never stops hotseat', () => {
		expect(awakeFrom('')).toBe(true);
		expect(awakeFrom('pmset: unknown option')).toBe(true);
	});
});
