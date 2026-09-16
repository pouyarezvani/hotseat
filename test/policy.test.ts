import { describe, expect, test } from 'bun:test';
import { decide } from '../src/core/auto.ts';
import {
	bindingRecoveryAt,
	decideTrigger,
	everyAccountAboveThreshold,
	headroom,
	leftAccountRecovered,
	noReturnAccount,
	type PolicySettings,
	rankCandidates,
	recoveryIsUseful,
	relevantWindows,
	type SwitchMemory,
	weeklyResetAt,
} from '../src/core/policy.ts';
import type { AccountState, ProviderState, UsageWindow } from '../src/core/types.ts';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const H = 3_600_000;
const inHours = (n: number): string => new Date(NOW + n * H).toISOString();

interface Spec {
	fiveHour?: [number, number];
	weekly?: [number, number];
	models?: Record<string, [number, number]>;
	disabled?: boolean;
}

function account(id: string, spec: Spec, slot = 1): AccountState {
	const windows: UsageWindow[] = [];
	if (spec.fiveHour) {
		windows.push({
			key: 'five_hour',
			label: '5h',
			percent: spec.fiveHour[0],
			resetsAt: inHours(spec.fiveHour[1]),
		});
	}
	if (spec.weekly) {
		windows.push({
			key: 'seven_day',
			label: 'week',
			percent: spec.weekly[0],
			resetsAt: inHours(spec.weekly[1]),
		});
	}
	for (const [name, [percent, resetsIn]] of Object.entries(spec.models ?? {})) {
		windows.push({
			key: `weekly_scoped:${name}`,
			label: name,
			percent,
			resetsAt: inHours(resetsIn),
		});
	}
	return {
		id,
		provider: 'claude',
		email: `${id}@example.com`,
		slot,
		disabled: spec.disabled ?? false,
		addedAt: inHours(-100),
		usage: { fetchedAt: inHours(0), windows },
	};
}

function unread(id: string, slot = 1): AccountState {
	return { ...account(id, {}, slot), usage: { fetchedAt: inHours(0), windows: [] } };
}

const policy: PolicySettings = {
	thresholdPercent: 90,
	cooldownSeconds: 300,
	modelLimits: [],
	unhealthyTicks: 3,
};

function state(accounts: AccountState[], activeAccountId?: string): ProviderState {
	return { accounts, ...(activeAccountId ? { activeAccountId } : {}) };
}

function rank(
	accounts: AccountState[],
	activeId: string,
	overrides: Partial<PolicySettings> = {},
	trigger: 'proactive' | 'at-limit' | 'failover' = 'proactive',
	noReturn?: string,
) {
	return rankCandidates({
		trigger,
		accounts,
		activeId,
		noReturn,
		settings: { ...policy, ...overrides },
		now: NOW,
	}).map((a) => a.id);
}

describe('which windows count', () => {
	const a = account('a', {
		fiveHour: [40, 2],
		weekly: [50, 100],
		models: { Fable: [96, 100], Opus: [10, 100] },
	});

	test('by default only the 5h and weekly windows', () => {
		expect(relevantWindows(a, []).map((w) => w.label)).toEqual(['5h', 'week']);
		expect(headroom(a, [])).toBe(50);
	});

	test('a named model is folded in, matched regardless of case', () => {
		expect(relevantWindows(a, ['fable']).map((w) => w.label)).toEqual(['5h', 'week', 'Fable']);
		expect(headroom(a, ['FABLE'])).toBe(4);
	});

	test('"all" folds in every model the account reports', () => {
		expect(relevantWindows(a, ['all']).map((w) => w.label)).toEqual([
			'5h',
			'week',
			'Fable',
			'Opus',
		]);
	});

	test('a model the account does not report is simply absent', () => {
		expect(relevantWindows(a, ['Sonnet']).map((w) => w.label)).toEqual(['5h', 'week']);
	});

	test('no reading at all is unknown, not full', () => {
		expect(headroom(unread('x'), [])).toBeUndefined();
	});
});

describe('reset times', () => {
	test('the weekly reset is the one used for spending perishable quota', () => {
		const a = account('a', { fiveHour: [10, 1], weekly: [20, 50] });
		expect(weeklyResetAt(a, NOW)).toBe(NOW + 50 * H);
	});

	test('a reset already in the past reads as unknown, so a just-rolled-over account is not "soonest"', () => {
		const a = account('a', { weekly: [20, -1] });
		expect(weeklyResetAt(a, NOW)).toBeUndefined();
	});

	test('the binding reset is that of the tightest window, chosen first', () => {
		// The looser 5h window resets in an hour; the 95% weekly one is what binds.
		const a = account('a', { fiveHour: [40, 1], weekly: [95, 60] });
		expect(bindingRecoveryAt(a, [], NOW)).toBe(NOW + 60 * H);
	});

	test('a binding window with no usable reset sorts last', () => {
		const a = account('a', { fiveHour: [40, 1] });
		const spent = {
			...a,
			usage: {
				fetchedAt: inHours(0),
				windows: [{ key: 'seven_day', label: 'week', percent: 95 }, ...(a.usage?.windows ?? [])],
			},
		};
		expect(bindingRecoveryAt(spent, [], NOW)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('deciding whether to switch', () => {
	const memory: SwitchMemory = {};

	test('holds while the account in use is below the threshold', () => {
		expect(decideTrigger(30, policy, memory, 0, NOW).hold).toContain('below the 90% limit');
	});

	test('over the threshold is proactive, at zero is at-limit', () => {
		expect(decideTrigger(8, policy, memory, 0, NOW).trigger).toBe('proactive');
		expect(decideTrigger(0, policy, memory, 0, NOW).trigger).toBe('at-limit');
	});

	test('no reading holds for a few checks, then fails over', () => {
		expect(decideTrigger(undefined, policy, memory, 0, NOW).hold).toContain('1 of 3');
		expect(decideTrigger(undefined, policy, memory, 2, NOW).hold).toContain('3 of 3');
		expect(decideTrigger(undefined, policy, memory, 3, NOW).trigger).toBe('failover');
	});

	test('the cooldown holds a proactive switch but never an at-limit one', () => {
		const recent: SwitchMemory = { lastSwitchAt: NOW - 60_000 };
		expect(decideTrigger(8, policy, recent, 0, NOW).hold).toContain('cooling down');
		expect(decideTrigger(0, policy, recent, 0, NOW).trigger).toBe('at-limit');
	});
});

describe('where a switch goes', () => {
	test('the scenario this exists for: the account that resets soonest with anything left', () => {
		// Using: about to run out. b: three quarters used, resets tomorrow.
		// c: untouched, resets in five days. The quarter left on b expires
		// tomorrow if it is not used, so b is where the switch goes.
		const accounts = [
			account('a', { weekly: [95, 100] }),
			account('b', { weekly: [75, 24] }, 2),
			account('c', { weekly: [0, 120] }, 3),
		];
		expect(rank(accounts, 'a')).toEqual(['b', 'c']);
	});

	test('the exact numbers do not matter, only who resets first', () => {
		const accounts = [
			account('a', { weekly: [95, 100] }),
			account('b', { weekly: [40, 30] }, 2),
			account('c', { weekly: [10, 60] }, 3),
			account('d', { weekly: [60, 10] }, 4),
		];
		expect(rank(accounts, 'a')).toEqual(['d', 'b', 'c']);
	});

	test('an account with nothing left is never chosen, however soon it resets', () => {
		const accounts = [
			account('a', { weekly: [95, 100] }),
			account('b', { weekly: [100, 1] }, 2),
			account('c', { weekly: [20, 60] }, 3),
		];
		expect(rank(accounts, 'a')).toEqual(['c']);
	});

	test('a proactive switch will not land on an account that is itself over the threshold', () => {
		const accounts = [
			account('a', { weekly: [95, 5] }),
			account('b', { weekly: [92, 1] }, 2),
			account('c', { weekly: [50, 60] }, 3),
		];
		expect(rank(accounts, 'a')).toEqual(['c']);
	});

	test('at the limit, any account with room beats staying stuck', () => {
		expect(
			rank(
				[account('a', { weekly: [100, 5] }), account('b', { weekly: [97, 5] }, 2)],
				'a',
				{},
				'at-limit',
			),
		).toEqual(['b']);
	});

	test('two accounts resetting together are ordered by room', () => {
		const accounts = [
			account('a', { weekly: [95, 100] }),
			account('b', { weekly: [60, 24] }, 2),
			account('c', { weekly: [20, 24] }, 3),
		];
		expect(rank(accounts, 'a')).toEqual(['c', 'b']);
	});

	test('an unknown reset sorts last, after every known one', () => {
		const accounts = [
			account('a', { weekly: [95, 100] }),
			account('b', { weekly: [10, -5] }, 2),
			account('c', { weekly: [40, 80] }, 3),
		];
		expect(rank(accounts, 'a')).toEqual(['c', 'b']);
	});

	test('skips a disabled account, an unread one, and the one it was told not to return to', () => {
		const accounts = [
			account('a', { weekly: [95, 5] }),
			account('b', { weekly: [10, 5], disabled: true }, 2),
			unread('c', 3),
			account('d', { weekly: [20, 5] }, 4),
			account('e', { weekly: [30, 9] }, 5),
		];
		expect(rank(accounts, 'a', {}, 'proactive', 'd')).toEqual(['e']);
	});
});

describe('when every account is over the threshold', () => {
	test('is recognised only when the account in use and every measured peer are over', () => {
		expect(everyAccountAboveThreshold([5, 8], 4, 90)).toBe(true);
		expect(everyAccountAboveThreshold([5, 50], 4, 90)).toBe(false);
		expect(everyAccountAboveThreshold([5, 8], 40, 90)).toBe(false);
		expect(everyAccountAboveThreshold([undefined], 4, 90)).toBe(false);
	});

	test('reset time decides when everything worth having is spent', () => {
		expect(recoveryIsUseful(NOW + 100 * H, NOW + 200 * H, 2, 2, NOW)).toBe(true);
	});

	test('reset time decides when either side is back within the horizon', () => {
		expect(recoveryIsUseful(NOW + 1 * H, NOW + 200 * H, 8, 8, NOW)).toBe(true);
		expect(recoveryIsUseful(NOW + 200 * H, NOW + 1 * H, 8, 8, NOW)).toBe(true);
		expect(recoveryIsUseful(NOW + 100 * H, NOW + 200 * H, 8, 8, NOW)).toBe(false);
	});

	test('all spent: moves to whichever account comes back soonest', () => {
		const accounts = [
			account('a', { weekly: [98, 100] }),
			account('b', { weekly: [97, 50] }, 2),
			account('c', { weekly: [99, 2] }, 3),
		];
		expect(rank(accounts, 'a')).toEqual(['c', 'b']);
	});

	test('all spent: will not move to an account that comes back later than the one in use', () => {
		const accounts = [account('a', { weekly: [98, 10] }), account('b', { weekly: [97, 50] }, 2)];
		expect(rank(accounts, 'a')).toEqual([]);
	});

	test('all over but with days to go: ranks by room, needing double the room to move', () => {
		const accounts = [
			account('a', { weekly: [92, 200] }),
			account('b', { weekly: [91, 200] }, 2),
			account('c', { weekly: [80, 200] }, 3),
		];
		expect(rank(accounts, 'a')).toEqual(['c']);
	});
});

describe('not bouncing straight back', () => {
	// The pair from the flap the original tool measured: 47 credential
	// rewrites in under four hours with the inputs frozen.
	const one = account('one', { weekly: [92, 109] });
	const two = account('two', { weekly: [97, 3.5] }, 2);

	test('the first leg moves to the account that resets soonest', () => {
		expect(rank([one, two], 'one')).toEqual(['two']);
	});

	test('the return leg is refused while the account just left has not changed', () => {
		const memory: SwitchMemory = {
			lastSwitchAt: NOW - 10 * 60_000,
			lastSwitchFrom: 'one',
			lastSwitchTo: 'two',
			leftHeadroom: 8,
			leftRecoveryAt: NOW + 109 * H,
			leftTrigger: 'proactive',
		};
		const recovered = leftAccountRecovered(memory, [one, two], 'two', policy, NOW);
		expect(recovered).toBe(false);
		const barred = noReturnAccount('proactive', memory, [one, two], 'two', recovered, policy);
		expect(barred).toBe('one');
		expect(rank([one, two], 'two', {}, 'proactive', barred)).toEqual([]);
	});

	test('the bar lifts once the account left has genuinely recovered', () => {
		const memory: SwitchMemory = {
			lastSwitchFrom: 'one',
			lastSwitchTo: 'two',
			leftHeadroom: 8,
			leftRecoveryAt: NOW + 109 * H,
			leftTrigger: 'proactive',
		};
		const refreshed = account('one', { weekly: [20, 109] });
		expect(leftAccountRecovered(memory, [refreshed, two], 'two', policy, NOW)).toBe(true);
	});

	test('the bar does not apply once the user has moved somewhere else by hand', () => {
		const memory: SwitchMemory = {
			lastSwitchFrom: 'one',
			lastSwitchTo: 'two',
			leftHeadroom: 8,
			leftTrigger: 'proactive',
		};
		const three = account('three', { weekly: [50, 10] }, 3);
		expect(
			noReturnAccount('proactive', memory, [one, two, three], 'three', false, policy),
		).toBeUndefined();
	});

	test('an at-limit switch is never barred from returning', () => {
		const memory: SwitchMemory = {
			lastSwitchFrom: 'one',
			lastSwitchTo: 'two',
			leftHeadroom: 8,
			leftTrigger: 'proactive',
		};
		expect(noReturnAccount('at-limit', memory, [one, two], 'two', false, policy)).toBeUndefined();
	});
});

describe('the whole decision', () => {
	test('a normal proactive move', () => {
		const verdict = decide(
			state([account('a', { weekly: [95, 5] }), account('b', { weekly: [10, 5] }, 2)], 'a'),
			policy,
			{},
			0,
			NOW,
		);
		expect(verdict.target?.id).toBe('b');
		expect(verdict.trigger).toBe('proactive');
	});

	test('explains why it is holding at the limit with nowhere to go', () => {
		const verdict = decide(
			state([account('a', { weekly: [100, 5] }), account('b', { weekly: [100, 1] }, 2)], 'a'),
			policy,
			{},
			0,
			NOW,
		);
		expect(verdict.hold).toContain('out of room too');
	});

	test('a model limit only matters once that model is named', () => {
		const accounts = [
			account('a', { fiveHour: [40, 2], weekly: [50, 100], models: { Fable: [97, 100] } }),
			account('b', { weekly: [10, 5] }, 2),
		];
		expect(decide(state(accounts, 'a'), policy, {}, 0, NOW).hold).toContain('below the 90% limit');
		expect(
			decide(state(accounts, 'a'), { ...policy, modelLimits: ['Fable'] }, {}, 0, NOW).target?.id,
		).toBe('b');
	});
});

describe('the weekly reset, whichever service reports it', () => {
	test('Codex reports its weekly window under its own key and is still ranked by it', () => {
		const codex: AccountState = {
			...account('x', {}),
			provider: 'codex',
			usage: {
				fetchedAt: inHours(0),
				windows: [
					{ key: 'primary', label: '5h', percent: 10, resetsAt: inHours(2) },
					{ key: 'secondary', label: 'week', percent: 30, resetsAt: inHours(30) },
				],
			},
		};
		expect(weeklyResetAt(codex, NOW)).toBe(NOW + 30 * H);
	});

	test('a model limit labelled week is not mistaken for the weekly window', () => {
		const odd: AccountState = {
			...account('x', {}),
			usage: {
				fetchedAt: inHours(0),
				windows: [{ key: 'weekly_scoped:week', label: 'week', percent: 30, resetsAt: inHours(30) }],
			},
		};
		expect(weeklyResetAt(odd, NOW)).toBeUndefined();
	});
});

describe('an account with a sliver left is not a landing spot', () => {
	const settings: PolicySettings = {
		thresholdPercent: 90,
		cooldownSeconds: 0,
		modelLimits: [],
		unhealthyTicks: 3,
	};

	test('a candidate with under 5% left is passed over for one with room, even if it resets sooner', () => {
		const accounts = [
			account('active', { weekly: [100, 100] }),
			account('sliver', { weekly: [97, 1] }, 2),
			account('room', { weekly: [60, 120] }, 3),
		];
		const [best] = rankCandidates({
			trigger: 'at-limit',
			accounts,
			activeId: 'active',
			noReturn: undefined,
			settings,
			now: NOW,
		});
		expect(best?.id).toBe('room');
	});

	test('with nothing better anywhere, the sliver still beats staying put', () => {
		const accounts = [
			account('active', { weekly: [100, 100] }),
			account('sliver', { weekly: [97, 1] }, 2),
		];
		const [best] = rankCandidates({
			trigger: 'at-limit',
			accounts,
			activeId: 'active',
			noReturn: undefined,
			settings,
			now: NOW,
		});
		expect(best?.id).toBe('sliver');
	});
});

describe('a login that stops answering', () => {
	const settings: PolicySettings = {
		thresholdPercent: 90,
		cooldownSeconds: 300,
		modelLimits: [],
		unhealthyTicks: 3,
	};

	test('fails over after enough failed reads even though its last numbers looked fine', () => {
		expect(decideTrigger(50, settings, {}, 3, NOW)).toEqual({ trigger: 'failover' });
	});

	test('is given its chances first, and the count is shown', () => {
		expect(decideTrigger(undefined, settings, {}, 1, NOW).hold).toBe(
			'no reading on the account in use, 2 of 3 before failing over',
		);
		expect(decideTrigger(50, settings, {}, 2, NOW).hold).toBe('at 50%, below the 90% limit');
	});

	test('a reading a hair under the limit is never described as at it', () => {
		expect(decideTrigger(10.4, settings, {}, 0, NOW).hold).toBe('at 89%, below the 90% limit');
	});
});
