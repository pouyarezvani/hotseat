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
	rankCandidates,
	type SwitchMemory,
	type Trigger,
	windowsOverThreshold,
} from './policy.ts';
import { loadSettings, type Settings } from './settings.ts';
import { activate } from './switch.ts';
import type { AccountState, Provider, ProviderId, ProviderState } from './types.ts';

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
		return { hold: verdict.hold ?? 'nothing to do', targets: [] };
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
	const memory: SwitchMemory = {
		lastSwitchAt: now,
		lastSwitchTo: input.toId,
		...(input.fromId ? { lastSwitchFrom: input.fromId } : {}),
		leftHeadroom: leftHeadroom ?? null,
		leftRecoveryAt:
			leftRecovery !== undefined && Number.isFinite(leftRecovery) ? leftRecovery : null,
		leftTrigger: 'proactive',
		...(forgiven.length > 0 ? { forgiven } : {}),
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
	options: { providers?: Record<ProviderId, Provider>; now?: number } = {},
): Promise<TickReport[]> {
	const settings = await loadSettings();
	const policy = policyOf(settings);
	const reports: TickReport[] = [];
	const state = await collectState(options);
	const auto = await loadAutoState();
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
		if (!decision.target) {
			reports.push({
				provider: providerId,
				outcome: 'holding',
				detail: decision.hold ?? 'nothing to do',
				...(decision.trigger ? { trigger: decision.trigger } : {}),
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
		// Memory is written before the history line, and to disk right away:
		// once the login has changed, a crash must not leave the next pass
		// free to change it straight back.
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
			detail: `switched to ${result.to}${restart}${passedOver}`,
			trigger,
			to: result.to,
		});
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
