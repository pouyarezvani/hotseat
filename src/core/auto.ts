import { join } from 'node:path';
import { collectState, PROVIDERS } from './collect.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
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
} from './policy.ts';
import { loadSettings, type Settings } from './settings.ts';
import { activate } from './switch.ts';
import type { Provider, ProviderId, ProviderState } from './types.ts';

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
	const stored = await readJson<Partial<AutoState>>(autoStatePath());
	if (stored?.version !== 2) return structuredClone(EMPTY);
	return { version: 2, memory: stored.memory ?? {} };
}

export function policyOf(settings: Settings): PolicySettings {
	return {
		thresholdPercent: settings.autoThresholdPercent,
		cooldownSeconds: settings.autoCooldownSeconds,
		modelLimits: settings.autoModelLimits,
		unhealthyTicks: settings.autoUnhealthyTicks,
	};
}

export interface Decision {
	target?: { id: string; email: string };
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
	if (!active) return { hold: 'no account is currently in use' };

	const activeHeadroom = headroom(active, policy.modelLimits);
	const verdict = decideTrigger(activeHeadroom, policy, memory, unhealthyTicks, now);
	if (verdict.hold !== undefined || verdict.trigger === undefined) {
		return { hold: verdict.hold ?? 'nothing to do' };
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
	const [target] = rankCandidates({
		trigger,
		accounts: providerState.accounts,
		activeId: active.id,
		noReturn,
		settings: policy,
		now,
	});
	if (!target) {
		const reason =
			trigger === 'at-limit' || trigger === 'failover'
				? 'every other account is out of room too'
				: 'no other account has room to switch to';
		return { hold: reason, trigger };
	}
	return { target: { id: target.id, email: target.email }, trigger };
}

/**
 * Records a switch the user made by hand so the automatic pass treats it the
 * way it treats its own: the cooldown applies, and the account left is held
 * back from an immediate return. Without this the next pass could reverse a
 * click seconds after it landed.
 */
export async function rememberManualSwitch(input: {
	provider: ProviderId;
	fromId?: string;
	toId: string;
	leftHeadroom?: number;
	leftRecoveryAt?: number;
	now?: number;
}): Promise<void> {
	const auto = await loadAutoState();
	const now = input.now ?? Date.now();
	auto.memory[input.provider] = {
		lastSwitchAt: now,
		lastSwitchTo: input.toId,
		...(input.fromId ? { lastSwitchFrom: input.fromId } : {}),
		leftHeadroom: input.leftHeadroom ?? null,
		leftRecoveryAt:
			input.leftRecoveryAt !== undefined && Number.isFinite(input.leftRecoveryAt)
				? input.leftRecoveryAt
				: null,
		leftTrigger: 'proactive',
	};
	await writeJsonAtomic(autoStatePath(), auto, 0o600);
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
		try {
			const result = await activate(providerId, decision.target.id, options);
			const leftHeadroom = active ? headroom(active, policy.modelLimits) : undefined;
			const leftRecovery = active
				? bindingRecoveryAt(active, policy.modelLimits, now)
				: Number.POSITIVE_INFINITY;
			// Memory is written before the history line, and to disk right away:
			// once the login has changed, a crash must not leave the next pass
			// free to change it straight back.
			auto.memory[providerId] = {
				lastSwitchAt: now,
				lastSwitchTo: decision.target.id,
				...(active ? { lastSwitchFrom: active.id } : {}),
				leftHeadroom: leftHeadroom ?? null,
				leftRecoveryAt: Number.isFinite(leftRecovery) ? leftRecovery : null,
				leftTrigger: trigger,
			};
			await writeJsonAtomic(autoStatePath(), auto, 0o600);
			await recordSwitch({
				at: new Date(now).toISOString(),
				provider: providerId,
				...(result.from ? { from: result.from } : {}),
				to: result.to,
				reason: 'auto',
				...(leftHeadroom !== undefined ? { leftAtPercent: Math.round(100 - leftHeadroom) } : {}),
			});
			reports.push({
				provider: providerId,
				outcome: 'switched',
				detail: `switched to ${result.to}${
					result.runningProcesses > 0 && !result.liveSwap
						? ` (${result.runningProcesses} open ${result.runningProcesses === 1 ? 'session keeps' : 'sessions keep'} the old account until restarted)`
						: ''
				}`,
				trigger,
				to: result.to,
			});
		} catch (error) {
			reports.push({
				provider: providerId,
				outcome: 'blocked',
				detail: (error as Error).message,
				trigger,
			});
		}
	}

	await writeJsonAtomic(autoStatePath(), auto, 0o600);
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
