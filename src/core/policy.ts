import type { AccountState, UsageWindow } from './types.ts';

/**
 * The switching policy. Pure: no I/O, no clock reads, no settings loads.
 * Everything it needs is passed in, so every branch can be driven from a
 * fixture and the same scenarios can be replayed against it forever.
 */

export type Trigger = 'proactive' | 'at-limit' | 'failover';

/**
 * There is one rule for where to go: the account whose weekly quota resets
 * soonest, among those that still have room. That quota is what expires
 * unused otherwise. An account that resets in five days can wait; one that
 * resets tomorrow with a quarter left cannot.
 */
export interface PolicySettings {
	thresholdPercent: number;
	cooldownSeconds: number;
	/** Model names whose own weekly limit counts, or 'all', or empty for none. */
	modelLimits: string[];
	/** Consecutive ticks with no reading on the account in use before failing over. */
	unhealthyTicks: number;
}

/** What the last switch left behind, so the next one cannot undo it blindly. */
export interface SwitchMemory {
	lastSwitchAt?: number;
	lastSwitchTo?: string;
	lastSwitchFrom?: string;
	leftHeadroom?: number | null;
	leftRecoveryAt?: number | null;
	leftTrigger?: Trigger;
}

/** Seconds an account's reset must beat another's by to count as sooner. */
export const RECOVERY_HYSTERESIS_S = 300;
/** Within this many seconds of a reset, ranking by reset time beats ranking by room. */
export const RECOVERY_HORIZON_S = 4 * 3600;
/** A peer must hold this many times the room of the account in use to be worth a move by room alone. */
export const HORIZON_HEADROOM_RATIO = 2;
/** Below this much room an account is as good as spent. */
export const SPENT_HEADROOM_PCT = 3;
/**
 * An account with a sliver of quota left is not a place to land: it would be
 * spent within a turn or two and trigger another switch. A candidate has to
 * carry at least this much of its tightest window to count as usable.
 */
export const MIN_USABLE_HEADROOM = 5;

export function isModelWindow(window: Pick<UsageWindow, 'key'>): boolean {
	return window.key.startsWith('weekly_scoped:');
}

/**
 * Every window that gates an account: always 5h and weekly, plus each named
 * model's own weekly limit. A model at 100% blocks that model even with room
 * in the overall windows, so for someone who uses it, it binds just as hard.
 */
export function relevantWindows(account: AccountState, modelLimits: string[]): UsageWindow[] {
	const windows = account.usage?.windows ?? [];
	const wanted = modelLimits.map((name) => name.toLowerCase());
	const all = wanted.includes('all');
	return windows.filter((window) => {
		if (!isModelWindow(window)) return true;
		if (all) return true;
		return wanted.includes(window.label.toLowerCase());
	});
}

/** Room left on the tightest counted window, or undefined with no reading. */
export function headroom(account: AccountState, modelLimits: string[]): number | undefined {
	const windows = relevantWindows(account, modelLimits);
	if (windows.length === 0) return undefined;
	return 100 - Math.max(...windows.map((window) => window.percent));
}

function parseReset(iso: string | undefined, now: number): number | undefined {
	if (!iso) return undefined;
	const ts = Date.parse(iso);
	// A reset already in the past is unknown, not imminent. Treating it as a
	// real instant would rank the account that just rolled over as "soonest".
	return Number.isFinite(ts) && ts > now ? ts : undefined;
}

/** The account-wide weekly window, whichever service is reporting it. */
export function isWeeklyWindow(window: Pick<UsageWindow, 'key' | 'label'>): boolean {
	return window.key === 'seven_day' || (!isModelWindow(window) && window.label === 'week');
}

/** When the weekly window resets. The 5h one recycles too fast to plan around. */
export function weeklyResetAt(account: AccountState, now: number): number | undefined {
	const weekly = account.usage?.windows.find(isWeeklyWindow);
	return parseReset(weekly?.resetsAt, now);
}

/**
 * When the tightest counted window resets. The tightest window is chosen
 * first and then asked for its reset, because filtering on reset first would
 * let a looser window answer for the one that actually binds.
 */
export function bindingRecoveryAt(
	account: AccountState,
	modelLimits: string[],
	now: number,
): number {
	const windows = relevantWindows(account, modelLimits);
	if (windows.length === 0) return Number.POSITIVE_INFINITY;
	const binding = windows.reduce((a, b) => (a.percent >= b.percent ? a : b));
	return parseReset(binding.resetsAt, now) ?? Number.POSITIVE_INFINITY;
}

export function everyAccountAboveThreshold(
	candidateHeadrooms: (number | undefined)[],
	activeHeadroom: number | undefined,
	threshold: number,
): boolean {
	if (activeHeadroom === undefined || 100 - activeHeadroom < threshold) return false;
	const measured = candidateHeadrooms.filter((h): h is number => h !== undefined);
	if (measured.length === 0) return false;
	return measured.every((h) => 100 - h >= threshold);
}

/**
 * Whether to rank a candidate by soonest reset rather than by room. Reset
 * wins when everything worth having is spent, and when either side of the
 * pair is back within the horizon. Asked of the pair, not the candidate
 * alone, so a switch cannot flip the axis and let each guard miss one leg.
 */
export function recoveryIsUseful(
	candidateRecoveryAt: number,
	activeRecoveryAt: number,
	activeHeadroom: number,
	bestCandidateHeadroom: number,
	now: number,
): boolean {
	if (activeHeadroom <= SPENT_HEADROOM_PCT && bestCandidateHeadroom <= SPENT_HEADROOM_PCT) {
		return true;
	}
	return (
		candidateRecoveryAt - now <= RECOVERY_HORIZON_S * 1000 ||
		activeRecoveryAt - now <= RECOVERY_HORIZON_S * 1000
	);
}

export interface Verdict {
	trigger?: Trigger;
	hold?: string;
}

/** Decides whether this tick should switch at all, and why. */
export function decideTrigger(
	activeHeadroom: number | undefined,
	settings: PolicySettings,
	memory: SwitchMemory,
	unhealthyTicks: number,
	now: number,
): Verdict {
	let trigger: Trigger;
	// A login that keeps failing to read is treated as gone, whatever its last
	// good numbers said: the numbers may be hours old and the token revoked.
	if (unhealthyTicks >= settings.unhealthyTicks && settings.unhealthyTicks > 0) {
		trigger = 'failover';
	} else if (activeHeadroom !== undefined) {
		const used = 100 - activeHeadroom;
		if (used < settings.thresholdPercent) {
			// Floored, so a reading a hair under the limit never prints as at it.
			return { hold: `at ${Math.floor(used)}%, below the ${settings.thresholdPercent}% limit` };
		}
		trigger = activeHeadroom <= 0 ? 'at-limit' : 'proactive';
	} else {
		return {
			hold: `no reading on the account in use, ${unhealthyTicks + 1} of ${settings.unhealthyTicks} before failing over`,
		};
	}
	if (trigger === 'proactive') {
		const last = memory.lastSwitchAt;
		if (last !== undefined && now - last < settings.cooldownSeconds * 1000) {
			const remaining = Math.round((settings.cooldownSeconds * 1000 - (now - last)) / 1000);
			return { hold: `cooling down for another ${remaining}s` };
		}
	}
	return { trigger };
}

/**
 * Whether the account left by the last switch has improved enough since to be
 * a fair target again. "Leaves nothing" is what every flap looks like on two
 * accounts, so the bar lifts on a change since departure, not on emptiness.
 */
export function leftAccountRecovered(
	memory: SwitchMemory,
	accounts: AccountState[],
	activeId: string | undefined,
	settings: PolicySettings,
	now: number,
): boolean {
	const cameFrom = memory.lastSwitchFrom;
	if (cameFrom === undefined) return true;
	if (!('leftHeadroom' in memory)) return true;
	const barred = accounts.find((account) => account.id === cameFrom);
	const active = accounts.find((account) => account.id === activeId);
	const h = barred ? headroom(barred, settings.modelLimits) : undefined;
	const activeHeadroom = active ? headroom(active, settings.modelLimits) : undefined;
	const leftHeadroom = memory.leftHeadroom;
	const leftRecovery = memory.leftRecoveryAt;

	const isFailoverSnapshot =
		memory.leftTrigger !== undefined
			? memory.leftTrigger === 'failover'
			: leftHeadroom == null && leftRecovery == null;

	if (isFailoverSnapshot) {
		if (h !== undefined && h > 100 - settings.thresholdPercent) return true;
		const peerRecovery = barred
			? bindingRecoveryAt(barred, settings.modelLimits, now)
			: Number.POSITIVE_INFINITY;
		const activeRecovery = active
			? bindingRecoveryAt(active, settings.modelLimits, now)
			: Number.POSITIVE_INFINITY;
		return (
			(Number.isFinite(activeRecovery) || peerRecovery - now <= RECOVERY_HORIZON_S * 1000) &&
			peerRecovery < activeRecovery - RECOVERY_HYSTERESIS_S * 1000
		);
	}
	if (h !== undefined) {
		if (activeHeadroom !== undefined) {
			if (h > activeHeadroom * HORIZON_HEADROOM_RATIO + SPENT_HEADROOM_PCT) return true;
		} else if (h > 100 - settings.thresholdPercent) {
			return true;
		}
	}
	if (
		typeof leftHeadroom === 'number' &&
		h !== undefined &&
		h >= Math.min(leftHeadroom + SPENT_HEADROOM_PCT, 100)
	) {
		return true;
	}
	const was = typeof leftRecovery === 'number' ? leftRecovery : Number.POSITIVE_INFINITY;
	const recovery = barred
		? bindingRecoveryAt(barred, settings.modelLimits, now)
		: Number.POSITIVE_INFINITY;
	return recovery < was - RECOVERY_HYSTERESIS_S * 1000;
}

/** The account a proactive switch may not return to yet, if any. */
export function noReturnAccount(
	trigger: Trigger,
	memory: SwitchMemory,
	accounts: AccountState[],
	activeId: string | undefined,
	recovered: boolean,
	settings: PolicySettings,
): string | undefined {
	const cameFrom = memory.lastSwitchFrom;
	if (trigger !== 'proactive' || cameFrom === undefined) return undefined;
	// The bar only applies while still on the account that switch landed on.
	if (
		memory.lastSwitchTo !== undefined &&
		activeId !== undefined &&
		memory.lastSwitchTo !== activeId
	) {
		return undefined;
	}
	if (!recovered) return cameFrom;
	const barred = accounts.find((account) => account.id === cameFrom);
	const active = accounts.find((account) => account.id === activeId);
	const leftHeadroom = barred ? headroom(barred, settings.modelLimits) : undefined;
	const activeHeadroom = active ? headroom(active, settings.modelLimits) : undefined;
	if (leftHeadroom !== undefined) {
		if (activeHeadroom !== undefined) {
			if (leftHeadroom >= activeHeadroom * HORIZON_HEADROOM_RATIO) return undefined;
		} else if (leftHeadroom > 100 - settings.thresholdPercent) {
			return undefined;
		}
	}
	return cameFrom;
}

type Key = [number, number, number] | [number, number] | [number];

function compareKeys(a: Key, b: Key): number {
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

export interface RankInput {
	trigger: Trigger;
	accounts: AccountState[];
	activeId: string | undefined;
	noReturn: string | undefined;
	settings: PolicySettings;
	now: number;
}

/**
 * Orders the accounts this trigger may move to, best first: soonest weekly
 * reset, then most room. Pure, so it can run on a stored reading to decide and
 * again on a fresh one to confirm before anything is written.
 */
export function rankCandidates(input: RankInput): AccountState[] {
	const { trigger, accounts, activeId, noReturn, settings, now } = input;
	const models = settings.modelLimits;
	const active = accounts.find((account) => account.id === activeId);
	const activeHeadroom = active ? headroom(active, models) : undefined;
	const pool = accounts.filter((account) => !account.disabled && account.id !== activeId);

	const allAbove = everyAccountAboveThreshold(
		pool.map((account) => headroom(account, models)),
		activeHeadroom,
		settings.thresholdPercent,
	);
	const bestCandidateHeadroom = Math.max(
		0,
		...pool.map((account) => headroom(account, models)).filter((h): h is number => h !== undefined),
	);
	const activeRecoveryAt = allAbove && active ? bindingRecoveryAt(active, models, now) : 0;

	const qualifying: [Key, AccountState][] = [];
	const fallback: [Key, AccountState][] = [];

	for (const candidate of pool) {
		const h = headroom(candidate, models);
		if (h === undefined) continue;
		if (h <= 0) continue;
		// Unless everywhere is spent, a landing spot needs real room, or the
		// next turn would only trigger another switch.
		if (h < MIN_USABLE_HEADROOM && !allAbove) continue;
		if (candidate.id === noReturn) continue;
		const resetAt = weeklyResetAt(candidate, now) ?? Number.POSITIVE_INFINITY;
		const recoveryAt = allAbove ? bindingRecoveryAt(candidate, models, now) : 0;
		let byRecovery = false;

		if (trigger === 'proactive') {
			// A proactive move lands somewhere healthy: an account that is itself
			// over the threshold would only trigger the next switch.
			if (100 - h >= settings.thresholdPercent && !allAbove) continue;
			if (allAbove) {
				// Everywhere is over the threshold, so "healthy" has no answer and
				// the question becomes which account comes back first.
				byRecovery = recoveryIsUseful(
					recoveryAt,
					activeRecoveryAt,
					activeHeadroom ?? 0,
					bestCandidateHeadroom,
					now,
				);
				if (byRecovery) {
					if (recoveryAt >= activeRecoveryAt - RECOVERY_HYSTERESIS_S * 1000) continue;
				} else if (h < (activeHeadroom ?? 0) * HORIZON_HEADROOM_RATIO) {
					if (
						(activeHeadroom ?? 0) <= SPENT_HEADROOM_PCT &&
						h >= (activeHeadroom ?? 0) &&
						recoveryAt < activeRecoveryAt - RECOVERY_HYSTERESIS_S * 1000
					) {
						fallback.push([[0, recoveryAt, -h], candidate]);
					}
					continue;
				}
			}
		}

		const key: Key =
			allAbove && trigger === 'proactive'
				? byRecovery
					? [0, recoveryAt, -h]
					: [1, -h, recoveryAt]
				: [resetAt, -h];
		qualifying.push([key, candidate]);
	}

	const ordered = qualifying.length > 0 ? qualifying : fallback;
	ordered.sort((a, b) => compareKeys(a[0], b[0]));
	return ordered.map(([, account]) => account);
}
