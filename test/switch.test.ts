import { describe, expect, test } from 'bun:test';
import { headroom, nextAvailable, pickNext, recoveryAt, rotateNext } from '../src/core/switch.ts';
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
				key: `w${index}`,
				label: `w${index}`,
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

describe('soonest-reset, the default', () => {
	test('picks the account whose quota refreshes first, not the emptiest one', () => {
		// b resets in 2h with a little room; c resets in 5 days with lots of room.
		// Spending b first is what keeps b's quota from expiring unused.
		const state = providerState(
			[
				account('a', 1, [{ percent: 95, resetsIn: 30 }]),
				account('b', 2, [{ percent: 70, resetsIn: 2 }]),
				account('c', 3, [{ percent: 5, resetsIn: 120 }]),
			],
			'a',
		);
		const picked = pickNext(state, { strategy: 'soonest-reset', hysteresisPercent: 10 });
		expect(picked?.id).toBe('b');
	});

	test('never picks an account with no room left, however soon it resets', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 95, resetsIn: 30 }]),
				account('b', 2, [{ percent: 100, resetsIn: 1 }]),
				account('c', 3, [{ percent: 40, resetsIn: 90 }]),
			],
			'a',
		);
		expect(pickNext(state, { strategy: 'soonest-reset', hysteresisPercent: 10 })?.id).toBe('c');
	});

	test('breaks a tie on reset time by taking the one with more room', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 95, resetsIn: 30 }]),
				account('b', 2, [{ percent: 80, resetsIn: 6 }]),
				account('c', 3, [{ percent: 20, resetsIn: 6 }]),
			],
			'a',
		);
		expect(pickNext(state, { strategy: 'soonest-reset', hysteresisPercent: 10 })?.id).toBe('c');
	});

	test('judges an account by its tightest window, not its roomiest', () => {
		// b looks fine on its first window but a model limit is nearly spent.
		const state = providerState(
			[
				account('a', 1, [{ percent: 95, resetsIn: 30 }]),
				account('b', 2, [
					{ percent: 10, resetsIn: 3 },
					{ percent: 99, resetsIn: 50 },
				]),
				account('c', 3, [{ percent: 30, resetsIn: 80 }]),
			],
			'a',
		);
		expect(headroom(state.accounts[1] as AccountState)).toBe(1);
		expect(recoveryAt(state.accounts[1] as AccountState)).toBe(Date.parse(inHours(50)));
		expect(pickNext(state, { strategy: 'soonest-reset', hysteresisPercent: 10 })?.id).toBe('c');
	});

	test('skips a disabled account and the one it was told to avoid', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 95, resetsIn: 30 }]),
				account('b', 2, [{ percent: 20, resetsIn: 2 }], { disabled: true }),
				account('c', 3, [{ percent: 20, resetsIn: 4 }]),
				account('d', 4, [{ percent: 20, resetsIn: 8 }]),
			],
			'a',
		);
		expect(
			pickNext(state, { strategy: 'soonest-reset', hysteresisPercent: 10, exclude: 'c' })?.id,
		).toBe('d');
	});
});

describe('most-left', () => {
	test('takes the account with the most remaining', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 95, resetsIn: 30 }]),
				account('b', 2, [{ percent: 70, resetsIn: 2 }]),
				account('c', 3, [{ percent: 5, resetsIn: 120 }]),
			],
			'a',
		);
		expect(pickNext(state, { strategy: 'most-left', hysteresisPercent: 10 })?.id).toBe('c');
	});

	test('stays put when no candidate is enough of an improvement', () => {
		const state = providerState(
			[
				account('a', 1, [{ percent: 60, resetsIn: 30 }]),
				account('b', 2, [{ percent: 55, resetsIn: 20 }]),
			],
			'a',
		);
		expect(pickNext(state, { strategy: 'most-left', hysteresisPercent: 10 })).toBeUndefined();
	});
});

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
