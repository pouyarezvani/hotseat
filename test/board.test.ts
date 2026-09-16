import { describe, expect, test } from 'bun:test';
import type { State } from '../src/core/types.ts';
import { headroomOf, renderBoard } from '../src/ui/board.ts';
import { stripAnsi, type Theme } from '../src/ui/style.ts';

const plain: Theme = { color: false, truecolor: false, unicode: true, width: 80 };
const ascii: Theme = { color: false, truecolor: false, unicode: false, width: 80 };
const now = Date.parse('2026-09-16T12:00:00Z');

function fixture(): State {
	return {
		version: 1,
		updatedAt: '2026-09-16T12:00:00Z',
		providers: {
			claude: {
				activeAccountId: 'a1',
				accounts: [
					{
						id: 'a1',
						provider: 'claude',
						email: 'first@example.com',
						slot: 1,
						disabled: false,
						addedAt: '2026-09-01T00:00:00Z',
						usage: {
							fetchedAt: '2026-09-16T12:00:00Z',
							windows: [
								{ key: 'five_hour', label: '5h', percent: 60, resetsAt: '2026-09-16T14:30:00Z' },
								{ key: 'seven_day', label: 'week', percent: 67 },
								{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 91 },
							],
						},
					},
					{
						id: 'a2',
						provider: 'claude',
						email: 'second@example.com',
						slot: 2,
						disabled: false,
						addedAt: '2026-09-01T00:00:00Z',
						usage: { fetchedAt: '2026-09-16T12:00:00Z', windows: [] },
					},
				],
			},
			codex: { accounts: [] },
		},
	};
}

const options = { theme: plain, barWidth: 14, now };

describe('renderBoard', () => {
	test('marks only the account in use and lists every window', () => {
		const out = stripAnsi(renderBoard(fixture(), options));
		const active = out.split('\n').find((line) => line.includes('first@example.com')) ?? '';
		const idle = out.split('\n').find((line) => line.includes('second@example.com')) ?? '';
		expect(active).toContain('●');
		expect(idle).toContain('○');
		expect(out).toContain('Fable');
		expect(out).toContain('2h 30m');
	});

	test('closes each account with a corner so the rows group visually', () => {
		const out = stripAnsi(renderBoard(fixture(), options));
		expect(out).toContain('├ 5h');
		expect(out).toContain('╰ Fable');
	});

	test('skips a service with no accounts instead of printing an empty heading', () => {
		expect(stripAnsi(renderBoard(fixture(), options))).not.toContain('Codex');
	});

	test('says so when an account has no reading rather than drawing an empty meter', () => {
		expect(stripAnsi(renderBoard(fixture(), options))).toContain('no reading yet');
	});

	test('surfaces a failed reading in place of the meters', () => {
		const state = fixture();
		const account = state.providers.claude.accounts[0];
		if (!account) throw new Error('fixture missing account');
		account.usage = { fetchedAt: '2026-09-16T12:00:00Z', windows: [], error: 'token expired' };
		expect(stripAnsi(renderBoard(state, options))).toContain('token expired');
	});

	test('counts only accounts that could actually be switched to', () => {
		// Account 1 is in use and account 2 has no reading, so neither is somewhere
		// to switch. A count that included them would promise a move that the
		// switcher would then refuse to make.
		expect(stripAnsi(renderBoard(fixture(), options))).toContain('nothing to switch to');
	});

	test('counts an account with real room left', () => {
		const state = fixture();
		const spare = state.providers.claude.accounts[1];
		if (!spare) throw new Error('fixture missing account');
		spare.usage = {
			fetchedAt: '2026-09-16T12:00:00Z',
			windows: [{ key: 'five_hour', label: '5h', percent: 10 }],
		};
		expect(stripAnsi(renderBoard(state, options))).toContain('1 to switch to');
	});

	test('does not count an account with only a sliver left', () => {
		const state = fixture();
		const spare = state.providers.claude.accounts[1];
		if (!spare) throw new Error('fixture missing account');
		spare.usage = {
			fetchedAt: '2026-09-16T12:00:00Z',
			windows: [{ key: 'five_hour', label: '5h', percent: 98 }],
		};
		expect(stripAnsi(renderBoard(state, options))).toContain('nothing to switch to');
	});

	test('does not count a disabled account', () => {
		const state = fixture();
		const spare = state.providers.claude.accounts[1];
		if (!spare) throw new Error('fixture missing account');
		spare.disabled = true;
		spare.usage = {
			fetchedAt: '2026-09-16T12:00:00Z',
			windows: [{ key: 'five_hour', label: '5h', percent: 0 }],
		};
		expect(stripAnsi(renderBoard(state, options))).toContain('nothing to switch to');
	});

	test('points at the add command when nothing is set up', () => {
		const empty: State = {
			version: 1,
			updatedAt: '2026-09-16T12:00:00Z',
			providers: { claude: { accounts: [] }, codex: { accounts: [] } },
		};
		expect(stripAnsi(renderBoard(empty, options))).toContain('hotseat add');
	});

	test('falls back to ascii meters on a terminal without box drawing', () => {
		const out = stripAnsi(renderBoard(fixture(), { ...options, theme: ascii }));
		expect(out).toContain('#');
		expect(out).not.toContain('█');
	});

	test('keeps every meter the same visual width', () => {
		const out = stripAnsi(renderBoard(fixture(), options));
		const widths = out
			.split('\n')
			.filter((line) => line.includes('█') || line.includes('░'))
			.map((line) => {
				const match = line.match(/[█▉▊▋▌▍▎▏░]+/g)?.join('') ?? '';
				return [...match].length;
			});
		expect(new Set(widths).size).toBe(1);
	});
});

describe('headroomOf', () => {
	test('reports the tightest window, not the average', () => {
		const account = fixture().providers.claude.accounts[0];
		if (!account) throw new Error('fixture missing account');
		expect(headroomOf(account)).toBe(9);
	});

	test('an unmeasured account has unknown headroom, not full headroom', () => {
		// Calling it full would rank it top and send a switch to an account whose
		// real level nobody knows. Unknown is the honest answer, and the switcher
		// skips it for exactly that reason.
		const account = fixture().providers.claude.accounts[1];
		if (!account) throw new Error('fixture missing account');
		expect(Number.isNaN(headroomOf(account))).toBe(true);
	});
});
