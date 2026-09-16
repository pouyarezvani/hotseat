import { PROVIDERS } from './collect.ts';
import { accountsFor, loadRegistry, updateRegistry } from './registry.ts';
import { loadSettings, type Settings, type Strategy } from './settings.ts';
import type { AccountState, ProviderId, ProviderState } from './types.ts';
import { loadCredential, storeCredential } from './vault.ts';

export interface SwitchResult {
	provider: ProviderId;
	from?: string;
	to: string;
	liveSwap: boolean;
	runningProcesses: number;
}

/** The share of every window that is still unused, worst window first. */
export function headroom(account: AccountState): number {
	const windows = account.usage?.windows ?? [];
	if (windows.length === 0) return Number.NaN;
	return 100 - Math.max(...windows.map((window) => window.percent));
}

/** When the tightest window frees up, which is what makes an account usable again. */
export function recoveryAt(account: AccountState): number {
	const windows = account.usage?.windows ?? [];
	if (windows.length === 0) return Number.POSITIVE_INFINITY;
	const worst = windows.reduce((a, b) => (a.percent >= b.percent ? a : b));
	const at = worst.resetsAt ? Date.parse(worst.resetsAt) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

export interface PickOptions {
	strategy: Strategy;
	hysteresisPercent: number;
	/** Never pick this one, even if it ranks first. */
	exclude?: string;
}

/**
 * An account with a sliver of quota left is not a place to land: it would be
 * spent within a turn or two and trigger another switch. A candidate has to
 * carry at least this much of its tightest window to count as usable.
 */
export const MIN_USABLE_HEADROOM = 5;

/**
 * Chooses which account to switch to. Returns nothing when no
 * candidate is a clear enough improvement to be worth the disruption of switching.
 */
export function pickNext(state: ProviderState, options: PickOptions): AccountState | undefined {
	const active = state.accounts.find((account) => account.id === state.activeAccountId);
	const activeHeadroom = active ? headroom(active) : Number.NaN;
	const candidates = state.accounts.filter(
		(account) =>
			!account.disabled &&
			account.id !== state.activeAccountId &&
			account.id !== options.exclude &&
			Number.isFinite(headroom(account)) &&
			headroom(account) >= MIN_USABLE_HEADROOM,
	);
	if (candidates.length === 0) return undefined;

	// Spend the quota that refreshes soonest, because that is the quota that is
	// otherwise wasted. Candidates are already filtered to those with room left,
	// so this never lands on an account that cannot be used.
	if (options.strategy === 'soonest-reset') {
		return [...candidates].sort(
			(a, b) => recoveryAt(a) - recoveryAt(b) || headroom(b) - headroom(a),
		)[0];
	}
	const best = [...candidates].sort((a, b) => headroom(b) - headroom(a))[0];
	if (!best) return undefined;
	if (
		Number.isFinite(activeHeadroom) &&
		headroom(best) - activeHeadroom < options.hysteresisPercent
	) {
		return undefined;
	}
	return best;
}

/** The next enabled account after the current one, in order, wrapping around. */
export function rotateNext(state: ProviderState): AccountState | undefined {
	const usable = state.accounts.filter((account) => !account.disabled);
	if (usable.length < 2) return undefined;
	const index = usable.findIndex((account) => account.id === state.activeAccountId);
	return usable[(index + 1) % usable.length];
}

/** The next account in order that still has room, wrapping around. */
export function nextAvailable(state: ProviderState): AccountState | undefined {
	const usable = state.accounts.filter((account) => !account.disabled);
	if (usable.length === 0) return undefined;
	const start = usable.findIndex((account) => account.id === state.activeAccountId);
	for (let step = 1; step <= usable.length; step += 1) {
		const candidate = usable[(start + step) % usable.length];
		if (!candidate || candidate.id === state.activeAccountId) continue;
		const room = headroom(candidate);
		if (!Number.isFinite(room) || room > 0) return candidate;
	}
	return undefined;
}

/**
 * Installs an account's stored credential as the live one. The credential is
 * refreshed first and written back to the vault, so a swap never installs a
 * token that is about to expire and never loses a rotated refresh token.
 */
export async function activate(
	providerId: ProviderId,
	accountId: string,
	settings?: Settings,
): Promise<SwitchResult> {
	await (settings ?? loadSettings());
	const provider = PROVIDERS[providerId];
	const registry = await loadRegistry();
	const target = accountsFor(registry, providerId).find((account) => account.id === accountId);
	if (!target) throw new Error(`no ${provider.displayName} account with id ${accountId}`);

	const stored = await loadCredential(target);
	if (!stored) {
		throw new Error(
			`no stored credential for ${target.email} - run "hotseat save ${providerId}" while it is signed in`,
		);
	}

	const refreshed = await provider.refreshIfNeeded(stored);
	if (refreshed !== stored) await storeCredential(target, refreshed);

	const previousId = registry.active[providerId];
	const previous = registry.accounts.find((account) => account.id === previousId);

	// Save the outgoing account's current login before overwriting it, so a token
	// the agent refreshed while that account was in use is not lost.
	if (previous && previous.id !== target.id) {
		const live = await provider.readAgentCredential().catch(() => null);
		if (live) {
			const identity = await provider.identify(live).catch(() => null);
			if (identity?.email === previous.email) await storeCredential(previous, live);
		}
	}

	const running = await provider.runningProcesses().catch(() => []);
	await provider.writeAgentCredential(refreshed);

	await updateRegistry((current) => {
		current.active[providerId] = target.id;
		const record = current.accounts.find((account) => account.id === target.id);
		if (record) record.lastActivatedAt = new Date().toISOString();
	});

	return {
		provider: providerId,
		...(previous ? { from: previous.email } : {}),
		to: target.email,
		liveSwap: provider.liveSwap,
		runningProcesses: running.length,
	};
}
