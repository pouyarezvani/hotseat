import { join } from 'node:path';
import { acquireLock, readJson, writeJsonAtomic } from './fs.ts';
import { hotseatHome } from './paths.ts';
import type { State, UsageWindow } from './types.ts';

/** One reading of one limit: when, and how full. */
export type Point = [at: number, percent: number];

interface History {
	version: 1;
	/** By account, then by limit. */
	series: Record<string, Record<string, Point[]>>;
}

export const HISTORY_KEEP_MS = 7 * 24 * 60 * 60_000;
/** How many evenly spaced values the trend of a limit is drawn from. */
export const TREND_POINTS = 28;

function historyPath(): string {
	return join(hotseatHome(), 'usage-history.json');
}

/**
 * Adds a reading to a limit's history. A run of readings that say the same
 * thing is kept as its first and last, so an idle account costs two points
 * however long it sits; anything older than a week is dropped.
 */
export function addPoint(points: Point[], at: number, percent: number): Point[] {
	const kept = points.filter(([t]) => at - t <= HISTORY_KEEP_MS);
	const last = kept.at(-1);
	if (last && at <= last[0]) return kept;
	const before = kept.at(-2);
	if (last && before && last[1] === percent && before[1] === percent) {
		kept[kept.length - 1] = [at, percent];
		return kept;
	}
	kept.push([at, percent]);
	return kept;
}

/**
 * When a limit will be full if it keeps filling as it has lately, or nothing
 * when it is not filling, will reset first, or there is too little to go on.
 * Only readings since the limit last reset count, over the last hour and a
 * half for a limit that resets within six hours and the last twelve hours
 * otherwise, and only once they span ten minutes and a full point.
 */
export function fullAt(
	points: readonly Point[],
	resetsAt: string | undefined,
	now: number,
): number | undefined {
	const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN;
	const soon = Number.isFinite(reset) && reset - now <= 6 * 60 * 60_000;
	const lookback = soon ? 90 * 60_000 : 12 * 60 * 60_000;
	let start = 0;
	for (let i = 1; i < points.length; i++) {
		const before = points[i - 1];
		const after = points[i];
		if (before && after && after[1] < before[1] - 1) start = i;
	}
	const recent = points.slice(start).filter(([t]) => now - t <= lookback);
	const first = recent[0];
	const last = recent.at(-1);
	if (!first || !last) return undefined;
	const span = last[0] - first[0];
	const gain = last[1] - first[1];
	if (span < 10 * 60_000 || gain < 1 || last[1] >= 100) return undefined;
	const eta = last[0] + ((100 - last[1]) / gain) * span;
	if (eta <= now) return undefined;
	if (Number.isFinite(reset) && eta >= reset) return undefined;
	if (!Number.isFinite(reset) && eta - now > HISTORY_KEEP_MS) return undefined;
	return eta;
}

/** A limit's last week as evenly spaced values, each the latest reading by then; empty with under two readings. */
export function trend(points: readonly Point[], now: number): number[] {
	if (points.length < 2) return [];
	const from = Math.max(points[0]?.[0] ?? now, now - HISTORY_KEEP_MS);
	if (now <= from) return [];
	const values: number[] = [];
	let index = 0;
	let value = points[0]?.[1] ?? 0;
	for (let step = 0; step < TREND_POINTS; step++) {
		const at = from + ((now - from) * step) / (TREND_POINTS - 1);
		for (let next = points[index]; next && next[0] <= at; next = points[index]) {
			value = next[1];
			index += 1;
		}
		values.push(value);
	}
	return values;
}

/**
 * Marks the limits whose name starts with one of these, whatever the capitals,
 * as left off the board. They stay in the board itself: what can be switched
 * to is still judged on every limit, and only what is drawn leaves them out.
 */
export function withoutLimits(state: State, names: readonly string[]): State {
	const hidden = names.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0);
	if (hidden.length === 0) return state;
	const providers = Object.fromEntries(
		Object.entries(state.providers).map(([id, provider]) => [
			id,
			{
				...provider,
				accounts: provider.accounts.map((account) =>
					account.usage
						? {
								...account,
								usage: {
									...account.usage,
									windows: account.usage.windows.map((window) =>
										hidden.some((name) => window.label.toLowerCase().startsWith(name))
											? { ...window, hidden: true }
											: window,
									),
								},
							}
						: account,
				),
			},
		]),
	) as State['providers'];
	return { ...state, providers };
}

/**
 * Records every good reading on the board, and hands back the board with each
 * limit's forecast and trend filled in. A reading that failed adds nothing:
 * its numbers are the last good ones, already recorded.
 */
export async function withHistory(state: State, now = Date.now()): Promise<State> {
	const lock = await acquireLock(hotseatHome(), 10_000, 'usage-history.lock');
	let history: History;
	try {
		const stored = await readJson<History>(historyPath()).catch(() => null);
		history = stored?.version === 1 ? stored : { version: 1, series: {} };
		const known = new Set<string>();
		let changed = false;
		for (const provider of Object.values(state.providers)) {
			for (const account of provider.accounts) {
				known.add(account.id);
				const at = Date.parse(account.usage?.fetchedAt ?? '');
				if (!account.usage || account.usage.error || !Number.isFinite(at)) continue;
				const mine = history.series[account.id] ?? {};
				for (const window of account.usage.windows) {
					const before = mine[window.key] ?? [];
					const after = addPoint(before, at, window.percent);
					if (after.length !== before.length || after.at(-1)?.[0] !== before.at(-1)?.[0]) {
						changed = true;
					}
					mine[window.key] = after;
				}
				history.series[account.id] = mine;
			}
		}
		for (const id of Object.keys(history.series)) {
			if (!known.has(id)) {
				delete history.series[id];
				changed = true;
			}
		}
		if (changed) await writeJsonAtomic(historyPath(), history);
	} finally {
		await lock.release();
	}
	const annotate = (accountId: string, window: UsageWindow): UsageWindow => {
		const points = history.series[accountId]?.[window.key] ?? [];
		const eta = fullAt(points, window.resetsAt, now);
		const values = trend(points, now);
		return {
			...window,
			...(eta !== undefined ? { fullAt: new Date(eta).toISOString() } : {}),
			...(values.length > 0 ? { trend: values } : {}),
		};
	};
	const providers = Object.fromEntries(
		Object.entries(state.providers).map(([id, provider]) => [
			id,
			{
				...provider,
				accounts: provider.accounts.map((account) =>
					account.usage
						? {
								...account,
								usage: {
									...account.usage,
									windows: account.usage.windows.map((window) => annotate(account.id, window)),
								},
							}
						: account,
				),
			},
		]),
	) as State['providers'];
	return { ...state, providers };
}
