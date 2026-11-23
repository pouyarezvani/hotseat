import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readJson } from '../src/core/fs.ts';
import type { State } from '../src/core/types.ts';
import {
	addPoint,
	fullAt,
	HISTORY_KEEP_MS,
	type Point,
	TREND_POINTS,
	trend,
	withHistory,
	withoutLimits,
} from '../src/core/usage-history.ts';
import { renderBoard } from '../src/ui/board.ts';
import { withHome } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-14T12:00:00Z');
const at = (ms: number): string => new Date(ms).toISOString();

describe("keeping a limit's readings", () => {
	test('each new reading is added after the last', () => {
		expect(addPoint([[NOW - HOUR, 10]], NOW, 12)).toEqual([
			[NOW - HOUR, 10],
			[NOW, 12],
		]);
	});

	test('a run of readings that say the same is kept as its first and last', () => {
		let points: Point[] = [];
		for (let i = 0; i < 6; i++) points = addPoint(points, NOW + i * MIN, 40);
		expect(points).toEqual([
			[NOW, 40],
			[NOW + 5 * MIN, 40],
		]);
	});

	test('a reading no newer than the last is not added again', () => {
		const points: Point[] = [[NOW, 10]];
		expect(addPoint(points, NOW, 10)).toEqual(points);
		expect(addPoint(points, NOW - MIN, 99)).toEqual(points);
	});

	test('anything older than a week is dropped', () => {
		expect(addPoint([[NOW - HISTORY_KEEP_MS - MIN, 5]], NOW, 6)).toEqual([[NOW, 6]]);
	});
});

describe('when a limit will be full at the pace it has been filling', () => {
	const reset = at(NOW + 4 * HOUR);

	test('ten points an hour from 70 is full in three hours, which is before it resets', () => {
		const points: Point[] = [
			[NOW - HOUR, 60],
			[NOW, 70],
		];
		expect(fullAt(points, reset, NOW)).toBe(NOW + 3 * HOUR);
	});

	test('a limit that will reset first is not forecast', () => {
		const points: Point[] = [
			[NOW - HOUR, 60],
			[NOW, 62],
		];
		expect(fullAt(points, reset, NOW)).toBeUndefined();
	});

	test('a limit that is not filling is not forecast', () => {
		expect(
			fullAt(
				[
					[NOW - HOUR, 60],
					[NOW, 60],
				],
				reset,
				NOW,
			),
		).toBeUndefined();
	});

	test('readings from before the limit last reset do not count', () => {
		const points: Point[] = [
			[NOW - 80 * MIN, 95],
			[NOW - 60 * MIN, 2],
			[NOW, 4],
		];
		// Two points an hour since the reset, not the fall from 95.
		expect(fullAt(points, reset, NOW)).toBeUndefined();
	});

	test('under ten minutes, or under one point, is too little to go on', () => {
		expect(
			fullAt(
				[
					[NOW - 5 * MIN, 50],
					[NOW, 60],
				],
				reset,
				NOW,
			),
		).toBeUndefined();
		expect(
			fullAt(
				[
					[NOW - HOUR, 50],
					[NOW, 50.5],
				],
				reset,
				NOW,
			),
		).toBeUndefined();
	});

	test('a limit that resets soon looks back an hour and a half, a weekly one twelve hours', () => {
		const points: Point[] = [
			[NOW - 10 * HOUR, 10],
			[NOW - HOUR, 80],
			[NOW, 90],
		];
		// Soon: only the last hour counts, ten points an hour, full in one.
		expect(fullAt(points, at(NOW + 3 * HOUR), NOW)).toBe(NOW + HOUR);
		// Weekly: eighty points in ten hours, full in an hour and a quarter.
		expect(fullAt(points, at(NOW + 3 * 24 * HOUR), NOW)).toBe(NOW + 1.25 * HOUR);
	});

	test('one reading is nothing to go on', () => {
		expect(fullAt([[NOW, 99]], reset, NOW)).toBeUndefined();
		expect(fullAt([], reset, NOW)).toBeUndefined();
	});
});

describe("a limit's last week as a line", () => {
	test('is evenly spaced, each value the latest reading by then', () => {
		const points: Point[] = [
			[NOW - 2 * HOUR, 0],
			[NOW - HOUR, 50],
			[NOW, 100],
		];
		const values = trend(points, NOW);
		expect(values.length).toBe(TREND_POINTS);
		expect(values[0]).toBe(0);
		expect(values.at(-1)).toBe(100);
		expect(values[Math.floor(TREND_POINTS / 2)]).toBe(50);
	});

	test('with under two readings there is no line', () => {
		expect(trend([[NOW, 5]], NOW)).toEqual([]);
		expect(trend([], NOW)).toEqual([]);
	});
});

function board(percent: number, fetchedAt: string, error?: string): State {
	return {
		version: 1,
		updatedAt: fetchedAt,
		providers: {
			claude: {
				activeAccountId: 'a',
				accounts: [
					{
						id: 'a',
						provider: 'claude',
						email: 'a@example.com',
						slot: 1,
						disabled: false,
						addedAt: fetchedAt,
						usage: {
							fetchedAt,
							windows: [{ key: 'five_hour', label: '5h', percent, resetsAt: at(NOW + 4 * HOUR) }],
							...(error ? { error } : {}),
						},
					},
				],
			},
			codex: { accounts: [] },
			antigravity: { accounts: [] },
			grok: { accounts: [] },
		},
	};
}

describe('the board with its history', () => {
	test('each good reading is recorded, and the limit carries its forecast and its line', async () => {
		await withHome(async (home) => {
			await withHistory(board(60, at(NOW - HOUR)), NOW - HOUR);
			const now = await withHistory(board(70, at(NOW)), NOW);
			const window = now.providers.claude.accounts[0]?.usage?.windows[0];
			expect(window?.fullAt).toBe(at(NOW + 3 * HOUR));
			expect(window?.trend?.length).toBe(TREND_POINTS);
			const kept = await readJson<{ series: Record<string, Record<string, Point[]>> }>(
				join(home, 'usage-history.json'),
			);
			expect(kept?.series.a?.five_hour).toEqual([
				[NOW - HOUR, 60],
				[NOW, 70],
			]);
		});
	});

	test('a limit that has reset since it was read gets no forecast until the new window is read', async () => {
		await withHome(async () => {
			await withHistory(board(60, at(NOW - HOUR)), NOW - HOUR);
			const before = await withHistory(board(70, at(NOW - HOUR / 2)), NOW - HOUR / 2);
			expect(before.providers.claude.accounts[0]?.usage?.windows[0]?.fullAt).toBeDefined();
			const cleared = board(70, at(NOW - HOUR / 2));
			const account = cleared.providers.claude.accounts[0];
			if (account?.usage) {
				account.usage.windows = [{ key: 'five_hour', label: '5h', percent: 0, cleared: true }];
			}
			const now = await withHistory(cleared, NOW);
			expect(now.providers.claude.accounts[0]?.usage?.windows[0]?.fullAt).toBeUndefined();
		});
	});

	test('a reading that failed adds nothing: its numbers are the last good ones', async () => {
		await withHome(async (home) => {
			await withHistory(board(60, at(NOW - HOUR)), NOW - HOUR);
			await withHistory(board(60, at(NOW - HOUR), 'could not read usage'), NOW);
			const kept = await readJson<{ series: Record<string, Record<string, Point[]>> }>(
				join(home, 'usage-history.json'),
			);
			expect(kept?.series.a?.five_hour).toEqual([[NOW - HOUR, 60]]);
		});
	});

	test('an account that is gone takes its history with it', async () => {
		await withHome(async (home) => {
			await withHistory(board(60, at(NOW)), NOW);
			const empty = board(0, at(NOW));
			empty.providers.claude.accounts = [];
			await withHistory(empty, NOW);
			const kept = await readJson<{ series: Record<string, unknown> }>(
				join(home, 'usage-history.json'),
			);
			expect(kept?.series).toEqual({});
		});
	});

	test('the first reading has no forecast and no line yet', async () => {
		await withHome(async () => {
			const now = await withHistory(board(60, at(NOW)), NOW);
			const window = now.providers.claude.accounts[0]?.usage?.windows[0];
			expect(window?.fullAt).toBeUndefined();
			expect(window?.trend).toBeUndefined();
		});
	});
});

describe('limits left off the board', () => {
	test('are the ones whose name starts with what was asked, whatever the capitals', () => {
		const state = board(60, at(NOW));
		const windows = state.providers.claude.accounts[0]?.usage?.windows ?? [];
		windows.push({ key: 'x', label: 'Claude and GPT week', percent: 100 });
		const marked = withoutLimits(state, ['claude and gpt']);
		expect(
			marked.providers.claude.accounts[0]?.usage?.windows.map((w) => [w.label, w.hidden === true]),
		).toEqual([
			['5h', false],
			['Claude and GPT week', true],
		]);
		expect(windows.some((window) => window.hidden)).toBe(false);
	});

	test('they stay in the board, so what can be switched to is still judged on every limit', () => {
		const state = board(10, at(NOW));
		const account = state.providers.claude.accounts[0];
		account?.usage?.windows.push({ key: 'x', label: 'Claude and GPT week', percent: 100 });
		delete state.providers.claude.activeAccountId;
		const text = renderBoard(withoutLimits(state, ['Claude and GPT']), {
			theme: { color: false, truecolor: false, unicode: true, width: 80 },
			barWidth: 10,
			now: NOW,
		});
		expect(text).toContain('nothing to switch to');
		expect(text).not.toContain('Claude and GPT');
	});

	test('with nothing asked, or only blanks, the board is as it was', () => {
		const state = board(60, at(NOW));
		expect(withoutLimits(state, [])).toBe(state);
		expect(withoutLimits(state, [' '])).toBe(state);
	});
});
