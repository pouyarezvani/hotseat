import { describe, expect, test } from 'bun:test';
import { nextAvailable, pickBest, rotateNext } from '../src/core/switch.ts';
import type { AccountState, ProviderState } from '../src/core/types.ts';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const inHours = (n: number): string => new Date(NOW + n * 3_600_000).toISOString();

function account(
	id: string,
	slot: number,
	windows: { percent: number; resetsIn: number }[],
	overrides: Partial<AccountState> = {},
): AccountState {
	return {
		id,
		provider: 'claude',
		email: `${id}@example.com`,
		slot,
		disabled: false,
		addedAt: inHours(-100),
		usage: {
			fetchedAt: inHours(0),
			windows: windows.map((window, index) => ({
				key: index === 0 ? 'seven_day' : `w${index}`,
				label: index === 0 ? 'week' : `w${index}`,
				percent: window.percent,
				resetsAt: inHours(window.resetsIn),
			})),
		},
		...overrides,
	};
}

function providerState(accounts: AccountState[], activeAccountId?: string): ProviderState {
	return { accounts, ...(activeAccountId ? { activeAccountId } : {}) };
}

describe('order-based moves', () => {
	test('rotate wraps around to the first account', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 10, resetsIn: 5 }]),
				account('b', 2, [{ percent: 10, resetsIn: 5 }]),
			],
			'b',
		);
		expect(rotateNext(state)?.id).toBe('a');
	});

	test('rotate refuses when only one account is usable', () => {
		const state = providerState([account('a', 1, [{ percent: 10, resetsIn: 5 }])], 'a');
		expect(rotateNext(state)).toBeUndefined();
	});

	test('next skips past an account that is fully spent', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 95, resetsIn: 5 }]),
				account('b', 2, [{ percent: 100, resetsIn: 5 }]),
				account('c', 3, [{ percent: 10, resetsIn: 5 }]),
			],
			'a',
		);
		expect(nextAvailable(state)?.id).toBe('c');
	});
});

describe('a deliberate switch now', () => {
	test('goes where automatic switching would: the soonest reset with room', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 30, resetsIn: 5 }]),
				account('b', 2, [{ percent: 60, resetsIn: 1 }]),
				account('c', 3, [{ percent: 10, resetsIn: 9 }]),
			],
			'a',
		);
		expect(pickBest(state, [], NOW)?.id).toBe('b');
	});

	test('returns nothing when no other account has any room', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 30, resetsIn: 5 }]),
				account('b', 2, [{ percent: 100, resetsIn: 1 }]),
			],
			'a',
		);
		expect(pickBest(state, [], NOW)).toBeUndefined();
	});
});
