import { liveIdentity, PROVIDERS } from './collect.ts';
import { MIN_USABLE_HEADROOM, headroom as policyHeadroom, rankCandidates } from './policy.ts';
import { accountsFor, loadRegistry, updateRegistry, upsertAccount } from './registry.ts';
import { adoptIfNewer, freshestLogin, sessionRunning } from './session.ts';
import type { AccountRecord, AccountState, Provider, ProviderId, ProviderState } from './types.ts';
import { storeCredential } from './vault.ts';

export { MIN_USABLE_HEADROOM };

export interface SwitchResult {
	provider: ProviderId;
	from?: string;
	fromId?: string;
	to: string;
	toId: string;
	liveSwap: boolean;
	runningProcesses: number;
	/** The target was already the login in use, so nothing was written. */
	alreadyActive: boolean;
	/** A login that was in use but not yet saved, kept as a new account first. */
	savedLogin?: { email: string; slot: number };
}

/**
 * Room left on the account's tightest counted window. Which windows count is
 * the same choice the automatic switch makes, so a person reading the board
 * and the switcher acting on it never disagree.
 */
export function headroom(account: AccountState, modelLimits: string[] = []): number {
	return policyHeadroom(account, modelLimits) ?? Number.NaN;
}

/**
 * The account a deliberate "switch now" goes to: the same one automatic
 * switching would choose, so the two never disagree.
 */
export function pickBest(
	state: ProviderState,
	modelLimits: string[],
	now = Date.now(),
): AccountState | undefined {
	const [best] = rankCandidates({
		trigger: 'at-limit',
		accounts: state.accounts,
		activeId: state.activeAccountId,
		noReturn: undefined,
		settings: { thresholdPercent: 90, cooldownSeconds: 0, modelLimits, unhealthyTicks: 1 },
		now,
	});
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
 *
 * The login being replaced is whichever one is actually installed, found by
 * asking the service, not by trusting what hotseat last wrote: a sign-in done
 * by hand in between must be saved too, or it would be lost. A login that
 * belongs to no saved account is saved as a new one before it is replaced.
 */
export async function activate(
	providerId: ProviderId,
	accountId: string,
	options: { providers?: Record<ProviderId, Provider>; now?: number } = {},
): Promise<SwitchResult> {
	const provider = (options.providers ?? PROVIDERS)[providerId];
	const now = options.now ?? Date.now();
	let registry = await loadRegistry();
	const target = accountsFor(registry, providerId).find((account) => account.id === accountId);
	if (!target) throw new Error(`no ${provider.displayName} account with id ${accountId}`);

	// A session running as this account may hold a newer token than the saved
	// copy; installing the older one would fail at its next refresh.
	const stored = await freshestLogin(provider, target);
	if (!stored) {
		throw new Error(
			`no saved login for ${target.email} - run "hotseat save ${providerId}" while it is signed in`,
		);
	}

	const live = await provider.readAgentCredential().catch(() => null);
	const identity = live ? await liveIdentity(provider, live, registry) : undefined;
	if (live && !identity) {
		// An installed login nobody can name would be overwritten unsaved,
		// and with it any token the agent rotated since it was last saved.
		throw new Error(
			'could not tell whose login is installed right now (offline?) - not switching, so nothing is lost',
		);
	}
	let previous: AccountRecord | undefined = identity
		? accountsFor(registry, providerId).find(
				(account) => account.email.toLowerCase() === identity.email.toLowerCase(),
			)
		: undefined;
	let savedLogin: SwitchResult['savedLogin'];
	if (live && identity && !previous) {
		previous = await updateRegistry((current) =>
			upsertAccount(current, {
				provider: providerId,
				email: identity.email,
				...(identity.plan ? { plan: identity.plan } : {}),
			}),
		);
		registry = await loadRegistry();
		await storeCredential(previous, live);
		savedLogin = { email: previous.email, slot: previous.slot };
	}

	const running = await provider.runningProcesses().catch(() => []);
	const base = {
		provider: providerId,
		to: target.email,
		toId: target.id,
		liveSwap: provider.liveSwap,
		runningProcesses: running.length,
	};
	if (previous && previous.id === target.id) {
		// Reinstalling the vault copy over a live login would throw away any
		// token the agent has rotated since, so an account already in use is
		// left exactly as it is.
		if (registry.active[providerId] !== target.id) {
			await updateRegistry((current) => {
				current.active[providerId] = target.id;
			});
		}
		return { ...base, from: previous.email, fromId: previous.id, alreadyActive: true };
	}

	if (await sessionRunning(provider, target)) {
		throw new Error(
			`${target.email} is open in another terminal (hotseat run) - close it first, or pick another account`,
		);
	}

	const refreshed = await provider.refreshIfNeeded(stored);
	if (refreshed !== stored) await storeCredential(target, refreshed);

	// Save the outgoing login before overwriting it, so a token the agent
	// refreshed while that account was in use is not lost. Never over a
	// newer sign-in already saved for that account.
	if (live && previous && !savedLogin) await adoptIfNewer(provider, previous, live);

	await provider.writeAgentCredential(refreshed);
	if (provider.recordIdentity) {
		const who = await provider.identify(refreshed).catch(() => ({ email: target.email }));
		await provider.recordIdentity(who).catch(() => undefined);
	}

	await updateRegistry((current) => {
		current.active[providerId] = target.id;
		const record = current.accounts.find((account) => account.id === target.id);
		if (record) record.lastActivatedAt = new Date(now).toISOString();
	});

	return {
		...base,
		...(previous ? { from: previous.email, fromId: previous.id } : {}),
		alreadyActive: false,
		...(savedLogin ? { savedLogin } : {}),
	};
}
