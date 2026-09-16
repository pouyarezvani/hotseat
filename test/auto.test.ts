import { describe, expect, test } from 'bun:test';
import { decide } from '../src/core/auto.ts';
import { DEFAULTS, type Settings } from '../src/core/settings.ts';
import type { AccountState, ProviderId, State } from '../src/core/types.ts';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const inHours = (n: number): string => new Date(NOW + n * 3_600_000).toISOString();

interface AutoState {
	version: 1;
	lastSwitchAt: Partial<Record<ProviderId, number>>;
	lastLeft: Partial<Record<ProviderId, { id: string; headroom: number }>>;
}

const fresh: AutoState = { version: 1, lastSwitchAt: {}, lastLeft: {} };

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

function state(accounts: AccountState[], activeAccountId?: string): State {
	return {
		version: 1,
		updatedAt: inHours(0),
		providers: {
			claude: { accounts, ...(activeAccountId ? { activeAccountId } : {}) },
			codex: { accounts: [] },
		},
	};
}

const settings: Settings = { ...DEFAULTS };

describe('holding still', () => {
	test('holds while the account in use is under the threshold', () => {
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 50, resetsIn: 5 }]),
					account('b', 2, [{ percent: 0, resetsIn: 5 }]),
				],
				'a',
			),
			'claude',
			settings,
			fresh,
			NOW,
		);
		expect(verdict).toHaveProperty('hold');
		expect('hold' in verdict && verdict.hold).toContain('under the 90% mark');
	});

	test('holds when no account is in use, rather than guessing one', () => {
		const verdict = decide(
			state([account('a', 1, [{ percent: 99, resetsIn: 5 }])]),
			'claude',
			settings,
			fresh,
			NOW,
		);
		expect('hold' in verdict && verdict.hold).toContain('no account');
	});

	test('holds when the account in use has no reading to judge', () => {
		const blind = account('a', 1, []);
		blind.usage = { fetchedAt: inHours(0), windows: [] };
		const verdict = decide(
			state([blind, account('b', 2, [{ percent: 0, resetsIn: 5 }])], 'a'),
			'claude',
			settings,
			fresh,
			NOW,
		);
		expect('hold' in verdict && verdict.hold).toContain('no usage reading');
	});

	test('holds when every other account is also full', () => {
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 5 }]),
					account('b', 2, [{ percent: 97, resetsIn: 5 }]),
				],
				'a',
			),
			'claude',
			settings,
			fresh,
			NOW,
		);
		expect('hold' in verdict && verdict.hold).toContain('no other account');
	});

	test('holds when the only candidate is disabled', () => {
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 5 }]),
					account('b', 2, [{ percent: 0, resetsIn: 5 }], { disabled: true }),
				],
				'a',
			),
			'claude',
			settings,
			fresh,
			NOW,
		);
		expect(verdict).toHaveProperty('hold');
	});
});

describe('the cooldown', () => {
	test('holds during the cooldown after a recent switch', () => {
		const recent: AutoState = { ...fresh, lastSwitchAt: { claude: NOW - 60_000 } };
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 5 }]),
					account('b', 2, [{ percent: 0, resetsIn: 5 }]),
				],
				'a',
			),
			'claude',
			settings,
			recent,
			NOW,
		);
		expect('hold' in verdict && verdict.hold).toContain('cooling down');
	});

	test('a spent account switches immediately, cooldown or not', () => {
		const recent: AutoState = { ...fresh, lastSwitchAt: { claude: NOW - 1_000 } };
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 100, resetsIn: 5 }]),
					account('b', 2, [{ percent: 0, resetsIn: 5 }]),
				],
				'a',
			),
			'claude',
			settings,
			recent,
			NOW,
		);
		expect(verdict).toHaveProperty('accountId', 'b');
	});

	test('switches once the cooldown has elapsed', () => {
		const old: AutoState = { ...fresh, lastSwitchAt: { claude: NOW - 600_000 } };
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 5 }]),
					account('b', 2, [{ percent: 0, resetsIn: 5 }]),
				],
				'a',
			),
			'claude',
			settings,
			old,
			NOW,
		);
		expect(verdict).toHaveProperty('accountId', 'b');
	});
});

describe('not going straight back', () => {
	test('will not return to the account it just left while it is no better', () => {
		const left: AutoState = { ...fresh, lastLeft: { claude: { id: 'b', headroom: 40 } } };
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 5 }]),
					account('b', 2, [{ percent: 60, resetsIn: 5 }]),
					account('c', 3, [{ percent: 70, resetsIn: 9 }]),
				],
				'a',
			),
			'claude',
			settings,
			left,
			NOW,
		);
		expect(verdict).toHaveProperty('accountId', 'c');
	});

	test('returns to it once it has actually recovered', () => {
		const left: AutoState = { ...fresh, lastLeft: { claude: { id: 'b', headroom: 2 } } };
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 5 }]),
					account('b', 2, [{ percent: 10, resetsIn: 5 }]),
				],
				'a',
			),
			'claude',
			settings,
			left,
			NOW,
		);
		expect(verdict).toHaveProperty('accountId', 'b');
	});
});

describe('which account it picks', () => {
	test('prefers the one whose quota resets soonest among those with room', () => {
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 30 }]),
					account('b', 2, [{ percent: 60, resetsIn: 2 }]),
					account('c', 3, [{ percent: 5, resetsIn: 200 }]),
				],
				'a',
			),
			'claude',
			settings,
			fresh,
			NOW,
		);
		expect(verdict).toHaveProperty('accountId', 'b');
	});

	test('takes the emptiest when told to prefer the most left', () => {
		const verdict = decide(
			state(
				[
					account('a', 1, [{ percent: 95, resetsIn: 30 }]),
					account('b', 2, [{ percent: 60, resetsIn: 2 }]),
					account('c', 3, [{ percent: 5, resetsIn: 200 }]),
				],
				'a',
			),
			'claude',
			{ ...settings, autoStrategy: 'most-left' },
			fresh,
			NOW,
		);
		expect(verdict).toHaveProperty('accountId', 'c');
	});

	test('a custom threshold is honoured', () => {
		const board = state(
			[
				account('a', 1, [{ percent: 82, resetsIn: 5 }]),
				account('b', 2, [{ percent: 0, resetsIn: 5 }]),
			],
			'a',
		);
		expect(decide(board, 'claude', settings, fresh, NOW)).toHaveProperty('hold');
		expect(
			decide(board, 'claude', { ...settings, autoThresholdPercent: 80 }, fresh, NOW),
		).toHaveProperty('accountId', 'b');
	});

	test('judges the account in use by its tightest window', () => {
		const verdict = decide(
			state(
				[
					account('a', 1, [
						{ percent: 10, resetsIn: 5 },
						{ percent: 96, resetsIn: 50 },
					]),
					account('b', 2, [{ percent: 0, resetsIn: 5 }]),
				],
				'a',
			),
			'claude',
			settings,
			fresh,
			NOW,
		);
		expect(verdict).toHaveProperty('accountId', 'b');
	});
});
