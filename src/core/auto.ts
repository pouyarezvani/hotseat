import { join } from 'node:path';
import { collectState, PROVIDERS } from './collect.ts';
import { acquireLock, readJsonLoose, writeJsonAtomic } from './fs.ts';
import { recordSwitch } from './history.ts';
import { hotseatHome } from './paths.ts';
import {
	bindingRecoveryAt,
	decideTrigger,
	headroom,
	leftAccountRecovered,
	noReturnAccount,
	type PolicySettings,
	RECOVERY_HYSTERESIS_S,
	rankCandidates,
	type SwitchMemory,
	type Trigger,
	weeklyResetAt,
	windowsOverThreshold,
} from './policy.ts';
import { accountsFor, loadRegistry } from './registry.ts';
import { loadSettings, type Settings } from './settings.ts';
import { activate } from './switch.ts';
import { holdSwitch } from './switch-lock.ts';
import type { AccountState, Provider, ProviderId, ProviderState } from './types.ts';
import { fingerprint } from './vault.ts';
import { fullyAwake } from './wake.ts';

export type TickOutcome = 'switched' | 'holding' | 'blocked';

export interface TickReport {
	provider: ProviderId;
	outcome: TickOutcome;
	detail: string;
	trigger?: Trigger;
	to?: string;
}

interface AutoState {
	version: 2;
	memory: Partial<Record<ProviderId, SwitchMemory>>;
}

const EMPTY: AutoState = { version: 2, memory: {} };

function autoStatePath(): string {
	return join(hotseatHome(), 'auto-state.json');
}

async function loadAutoState(): Promise<AutoState> {
	const stored = await readJsonLoose<Partial<AutoState>>(autoStatePath());
	if (stored?.version !== 2) return structuredClone(EMPTY);
	return { version: 2, memory: stored.memory ?? {} };
}

/**
 * Holds an account chosen by hand before its week was known to the first week
 * seen for it, unless another account has been switched to since.
 */
async function bindChosenReset(
	provider: ProviderId,
	seen: SwitchMemory,
	resetAt: number,
): Promise<void> {
	const lock = await acquireLock(hotseatHome(), 10_000, 'auto.lock');
	try {
		const auto = await loadAutoState();
		const latest = auto.memory[provider];
		if (!latest || latest.lastSwitchTo !== seen.lastSwitchTo || latest.chosenResetAt !== null)
			return;
		latest.chosenResetAt = resetAt;
		await writeJsonAtomic(autoStatePath(), auto, 0o600);
	} finally {
		await lock.release();
	}
}

/** Rewrites one service's memory under the lock, so two passes cannot lose each other's. */
async function rememberFor(provider: ProviderId, memory: SwitchMemory): Promise<void> {
	const lock = await acquireLock(hotseatHome(), 10_000, 'auto.lock');
	try {
		const auto = await loadAutoState();
		auto.memory[provider] = memory;
		await writeJsonAtomic(autoStatePath(), auto, 0o600);
	} finally {
		await lock.release();
	}
}

export function policyOf(settings: Settings): PolicySettings {
	return {
		thresholdPercent: settings.autoThresholdPercent,
		thresholdFiveHour: settings.autoThresholdFiveHour,
		thresholdWeekly: settings.autoThresholdWeekly,
		cooldownSeconds: settings.autoCooldownSeconds,
		modelLimits: settings.autoModelLimits,
		unhealthyTicks: settings.autoUnhealthyTicks,
	};
}

export interface Decision {
	/** The first choice, when there is one. */
	target?: { id: string; email: string };
	/** Every usable account in order, so a first choice that fails has a runner-up. */
	targets: { id: string; email: string }[];
	trigger?: Trigger;
	hold?: string;
	/**
	 * The weekly reset to hold an account chosen by hand to, when it was chosen
	 * before its week was known and this is the first week seen for it.
	 */
	chosenResetAt?: number;
}

/** One provider's decision, from a state fixture and a memory. Pure. */
export function decide(
	providerState: ProviderState,
	policy: PolicySettings,
	memory: SwitchMemory,
	unhealthyTicks: number,
	now: number,
): Decision {
	const active = providerState.accounts.find(
		(account) => account.id === providerState.activeAccountId,
	);
	if (!active) return { hold: 'no account is currently in use', targets: [] };

	const verdict = decideTrigger(active, policy, memory, unhealthyTicks, now);
	if (verdict.hold !== undefined || verdict.trigger === undefined) {
		const hold = verdict.hold ?? 'nothing to do';
		return verdict.belowLimits
			? soonerReset(providerState, active, policy, memory, now, hold)
			: { hold, targets: [] };
	}
	const trigger = verdict.trigger;

	const recovered = leftAccountRecovered(memory, providerState.accounts, active.id, policy, now);
	const noReturn = noReturnAccount(
		trigger,
		memory,
		providerState.accounts,
		active.id,
		recovered,
		policy,
	);
	const ranked = rankCandidates({
		trigger,
		accounts: providerState.accounts,
		activeId: active.id,
		noReturn,
		settings: policy,
		now,
	}).map((account) => ({ id: account.id, email: account.email }));
	const [target] = ranked;
	if (!target) {
		const reason =
			trigger === 'at-limit' || trigger === 'failover'
				? 'every other account is out of room too'
				: 'no other account has room to switch to';
		return { hold: reason, trigger, targets: [] };
	}
	return { target, targets: ranked, trigger };
}

/**
 * Leaves the account in use, which is below its limits, for the account with
 * room whose week resets soonest, when that is sooner than its own. An account
 * chosen by hand stays until its own week has reset, and the cooldown after a
 * switch applies.
 */
function soonerReset(
	providerState: ProviderState,
	active: AccountState,
	policy: PolicySettings,
	memory: SwitchMemory,
	now: number,
	hold: string,
): Decision {
	const activeReset = weeklyResetAt(active, now);
	if (activeReset === undefined) return { hold, targets: [] };
	const margin = RECOVERY_HYSTERESIS_S * 1000;
	const chosenAt = memory.chosenResetAt;
	const chosenByHand = memory.lastSwitchTo === active.id && chosenAt !== undefined;
	const bind = chosenByHand && chosenAt === null ? { chosenResetAt: activeReset } : {};
	const ranked = rankCandidates({
		trigger: 'expiring',
		accounts: providerState.accounts,
		activeId: active.id,
		noReturn: undefined,
		settings: policy,
		now,
	})
		.filter((account) => {
			const resetAt = weeklyResetAt(account, now);
			return resetAt !== undefined && resetAt < activeReset - margin;
		})
		.map((account) => ({ id: account.id, email: account.email }));
	const [target] = ranked;
	if (!target) return { hold, targets: [], ...bind };
	if (chosenByHand && (chosenAt === null || Math.abs(activeReset - chosenAt) <= margin)) {
		return {
			hold: 'staying on the account you chose until its week resets',
			targets: [],
			...bind,
		};
	}
	const last = memory.lastSwitchAt;
	if (last !== undefined && now - last < policy.cooldownSeconds * 1000) {
		const remaining = Math.round((policy.cooldownSeconds * 1000 - (now - last)) / 1000);
		return { hold: `cooling down for another ${remaining}s`, targets: [] };
	}
	return { target, targets: ranked, trigger: 'expiring' };
}

/**
 * Records a switch the user made by hand so the automatic pass treats it the
 * way it treats its own: the cooldown applies, and the account left is held
 * back from an immediate return. Without this the next pass could reverse a
 * click seconds after it landed.
 */
export async function rememberManualSwitch(input: {
	provider: ProviderId;
	/** The board as it was before the switch, which is what the choice was made on. */
	state: ProviderState;
	fromId?: string;
	toId: string;
	settings: Settings;
	now?: number;
}): Promise<SwitchMemory> {
	const now = input.now ?? Date.now();
	const policy = policyOf(input.settings);
	const leaving = input.state.accounts.find((account) => account.id === input.fromId);
	const arriving = input.state.accounts.find((account) => account.id === input.toId);
	const leftHeadroom = leaving ? headroom(leaving, policy.modelLimits) : undefined;
	const leftRecovery = leaving ? bindingRecoveryAt(leaving, policy.modelLimits, now) : undefined;
	// Whatever was already over its limit on the account chosen is not a
	// reason to move off it again: it was on screen, and chosen anyway.
	const forgiven = arriving ? windowsOverThreshold(arriving, policy) : [];
	const chosenResetAt = arriving ? weeklyResetAt(arriving, now) : undefined;
	const memory: SwitchMemory = {
		lastSwitchAt: now,
		lastSwitchTo: input.toId,
		...(input.fromId ? { lastSwitchFrom: input.fromId } : {}),
		leftHeadroom: leftHeadroom ?? null,
		leftRecoveryAt:
			leftRecovery !== undefined && Number.isFinite(leftRecovery) ? leftRecovery : null,
		leftTrigger: 'proactive',
		...(forgiven.length > 0 ? { forgiven } : {}),
		chosenResetAt: chosenResetAt ?? null,
	};
	await rememberFor(input.provider, memory);
	return memory;
}

/** The names of the limits forgiven by a memory, for telling the person. */
export function forgivenNames(memory: SwitchMemory, account: AccountState | undefined): string[] {
	const forgiven = memory.forgiven ?? [];
	return (account?.usage?.windows ?? [])
		.filter((window) => forgiven.some((entry) => entry.key === window.key))
		.map((window) => window.label);
}

/** One pass over every enabled service. Returns what it did, for logging. */
export async function tick(
	options: {
		providers?: Record<ProviderId, Provider>;
		now?: number;
		awake?: () => Promise<boolean>;
	} = {},
): Promise<TickReport[]> {
	const settings = await loadSettings();
	const policy = policyOf(settings);
	const reports: TickReport[] = [];
	// A pass while the lid is closed reads nothing and moves nothing: the Mac
	// may sleep again mid-request, and nobody is using an agent anyway.
	if (!(await (options.awake ?? fullyAwake)())) {
		const registry = await loadRegistry();
		return (Object.keys(PROVIDERS) as ProviderId[])
			.filter(
				(provider) =>
					settings.autoProviders.includes(provider) && accountsFor(registry, provider).length >= 2,
			)
			.map((provider) => ({
				provider,
				outcome: 'holding',
				detail: 'the Mac is asleep - waiting until it wakes',
			}));
	}
	// Read before the accounts are, and compared again before this pass acts.
	const auto = await loadAutoState();
	const providers = options.providers ?? PROVIDERS;
	const inUseBefore = new Map<ProviderId, string | null>();
	for (const providerId of Object.keys(providers) as ProviderId[]) {
		if (!settings.autoProviders.includes(providerId)) continue;
		const installed = await providers[providerId].readAgentCredential().catch(() => undefined);
		if (installed !== undefined)
			inUseBefore.set(providerId, installed ? fingerprint(installed) : null);
	}
	const state = await collectState(options);
	const now = options.now ?? Date.now();

	for (const providerId of Object.keys(PROVIDERS) as ProviderId[]) {
		if (!settings.autoProviders.includes(providerId)) continue;
		const providerState = state.providers[providerId];
		if (providerState.accounts.length < 2) continue;

		const memory = auto.memory[providerId] ?? {};
		const active = providerState.accounts.find(
			(account) => account.id === providerState.activeAccountId,
		);
		// Reads that failed in a row on the account in use, counted by the
		// collector per attempt, so a cached failure seen twice counts once.
		const unhealthy = active?.usage?.failedReads ?? 0;

		const decision = decide(providerState, policy, memory, unhealthy, now);
		if (decision.chosenResetAt !== undefined) {
			await bindChosenReset(providerId, memory, decision.chosenResetAt);
		}
		if (!decision.target) {
			reports.push({
				provider: providerId,
				outcome: 'holding',
				detail: decision.hold ?? 'nothing to do',
				...(decision.trigger ? { trigger: decision.trigger } : {}),
			});
			continue;
		}
		// Acts only if no switch was remembered, and no other login went in,
		// since this pass began.
		const held = await holdSwitch(providerId);
		try {
			const latest = (await loadAutoState()).memory[providerId] ?? {};
			if (latest.lastSwitchAt !== memory.lastSwitchAt) {
				reports.push({
					provider: providerId,
					outcome: 'holding',
					detail:
						'the account in use was switched while this pass was deciding - deciding again next pass',
				});
				continue;
			}
			const installed = await providers[providerId].readAgentCredential().catch(() => undefined);
			const inUseNow =
				installed === undefined ? undefined : installed ? fingerprint(installed) : null;
			if (inUseNow === undefined || inUseNow !== inUseBefore.get(providerId)) {
				reports.push({
					provider: providerId,
					outcome: 'holding',
					detail:
						'the login in use changed while this pass was deciding - deciding again next pass',
				});
				continue;
			}
			const trigger = decision.trigger ?? 'proactive';
			const skipped: string[] = [];
			let landed: Awaited<ReturnType<typeof activate>> | undefined;
			let chosen = decision.target;
			for (const candidate of decision.targets) {
				try {
					landed = await activate(providerId, candidate.id, options);
					chosen = candidate;
					break;
				} catch (error) {
					skipped.push(`${candidate.email}: ${(error as Error).message}`);
				}
			}
			if (!landed || !chosen) {
				reports.push({
					provider: providerId,
					outcome: 'blocked',
					detail: skipped.join('; ') || 'no account could be switched to',
					trigger,
				});
				continue;
			}
			const result = landed;
			const leftHeadroom = active ? headroom(active, policy.modelLimits) : undefined;
			const leftRecovery = active
				? bindingRecoveryAt(active, policy.modelLimits, now)
				: Number.POSITIVE_INFINITY;
			// The switch is remembered on disk before its history line is written.
			await rememberFor(providerId, {
				lastSwitchAt: now,
				lastSwitchTo: chosen.id,
				...(active ? { lastSwitchFrom: active.id } : {}),
				leftHeadroom: leftHeadroom ?? null,
				leftRecoveryAt: Number.isFinite(leftRecovery) ? leftRecovery : null,
				leftTrigger: trigger,
			});
			await recordSwitch({
				at: new Date(now).toISOString(),
				provider: providerId,
				...(result.from ? { from: result.from } : {}),
				to: result.to,
				reason: 'auto',
				...(leftHeadroom !== undefined ? { leftAtPercent: Math.round(100 - leftHeadroom) } : {}),
			});
			const restart =
				result.runningProcesses > 0 && !result.liveSwap
					? ` (${result.runningProcesses} open ${result.runningProcesses === 1 ? 'session keeps' : 'sessions keep'} the old account until restarted)`
					: '';
			const passedOver = skipped.length > 0 ? ` after passing over ${skipped.join('; ')}` : '';
			reports.push({
				provider: providerId,
				outcome: 'switched',
				detail: `switched to ${result.to}${trigger === 'expiring' ? ', whose week resets sooner' : ''}${restart}${passedOver}`,
				trigger,
				to: result.to,
			});
		} finally {
			await held.release();
		}
	}

	return reports;
}

/** Runs until interrupted, pacing itself from the configured interval. */
export async function loop(log: (line: string) => void): Promise<void> {
	for (;;) {
		const settings = await loadSettings();
		const reports = await tick();
		for (const report of reports) {
			log(`${new Date().toLocaleTimeString()}  ${report.provider}  ${report.detail}`);
		}
		const jitter = 0.9 + Math.random() * 0.2;
		await Bun.sleep(settings.autoIntervalSeconds * 1000 * jitter);
	}
}
