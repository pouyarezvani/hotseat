import { join } from 'node:path';
import { collectState, PROVIDERS } from './collect.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { recordSwitch } from './history.ts';
import { hotseatHome } from './paths.ts';
import { loadSettings, type Settings } from './settings.ts';
import { activate, headroom, pickNext } from './switch.ts';
import type { ProviderId, State } from './types.ts';

export type TickOutcome = 'switched' | 'holding' | 'blocked' | 'idle';

export interface TickReport {
	provider: ProviderId;
	outcome: TickOutcome;
	detail: string;
	to?: string;
}

interface AutoState {
	version: 1;
	/** Per provider, when the last automatic switch landed. */
	lastSwitchAt: Partial<Record<ProviderId, number>>;
	/** The account each provider most recently left, held back from an immediate return. */
	lastLeft: Partial<Record<ProviderId, { id: string; headroom: number }>>;
}

const EMPTY: AutoState = { version: 1, lastSwitchAt: {}, lastLeft: {} };

function autoStatePath(): string {
	return join(hotseatHome(), 'auto-state.json');
}

async function loadAutoState(): Promise<AutoState> {
	return (await readJson<AutoState>(autoStatePath())) ?? structuredClone(EMPTY);
}

/**
 * Decides one provider's move. Kept separate from the loop and from any I/O so
 * the policy can be tested directly against a state fixture.
 */
export function decide(
	state: State,
	providerId: ProviderId,
	settings: Settings,
	auto: AutoState,
	now: number,
): { accountId: string; email: string } | { hold: string } {
	const providerState = state.providers[providerId];
	const active = providerState.accounts.find(
		(account) => account.id === providerState.activeAccountId,
	);
	if (!active) return { hold: 'no account is currently in use' };

	const room = headroom(active);
	if (!Number.isFinite(room)) return { hold: 'no usage reading for the current account' };
	const used = 100 - room;
	if (used < settings.autoThresholdPercent) {
		return { hold: `at ${Math.round(used)}%, under the ${settings.autoThresholdPercent}% mark` };
	}

	// A switch that lands because the account is fully spent cannot wait for the
	// cooldown: there is nothing left to wait with.
	const spent = room <= 0;
	const lastSwitch = auto.lastSwitchAt[providerId] ?? 0;
	const sinceSwitch = (now - lastSwitch) / 1000;
	if (!spent && sinceSwitch < settings.autoCooldownSeconds) {
		return {
			hold: `cooling down for another ${Math.round(settings.autoCooldownSeconds - sinceSwitch)}s`,
		};
	}

	// Hold back the account just left until it has recovered enough to be a real
	// improvement, so two accounts near the same level cannot ping-pong.
	const left = auto.lastLeft[providerId];
	const exclude =
		left &&
		(() => {
			const candidate = providerState.accounts.find((account) => account.id === left.id);
			if (!candidate) return false;
			const candidateRoom = headroom(candidate);
			return !Number.isFinite(candidateRoom) || candidateRoom <= left.headroom + 3;
		})()
			? left.id
			: undefined;

	const target = pickNext(providerState, {
		strategy: settings.autoStrategy,
		hysteresisPercent: spent ? 0 : settings.autoHysteresisPercent,
		...(exclude ? { exclude } : {}),
	});
	if (!target) return { hold: 'no other account has meaningfully more room' };
	return { accountId: target.id, email: target.email };
}

/** One pass over every enabled provider. Returns what it did, for logging. */
export async function tick(): Promise<TickReport[]> {
	const settings = await loadSettings();
	const reports: TickReport[] = [];
	if (!settings.autoEnabled) {
		return [{ provider: 'claude', outcome: 'idle', detail: 'automatic switching is off' }];
	}
	const state = await collectState();
	const auto = await loadAutoState();
	const now = Date.now();

	for (const providerId of Object.keys(PROVIDERS) as ProviderId[]) {
		if (!settings.autoProviders.includes(providerId)) continue;
		const providerState = state.providers[providerId];
		if (providerState.accounts.length < 2) continue;

		const verdict = decide(state, providerId, settings, auto, now);
		if ('hold' in verdict) {
			reports.push({ provider: providerId, outcome: 'holding', detail: verdict.hold });
			continue;
		}
		const leaving = providerState.accounts.find(
			(account) => account.id === providerState.activeAccountId,
		);
		try {
			const result = await activate(providerId, verdict.accountId, settings);
			await recordSwitch({
				at: new Date(now).toISOString(),
				provider: providerId,
				...(result.from ? { from: result.from } : {}),
				to: result.to,
				reason: 'auto',
				...(leaving ? { leftAtPercent: Math.round(100 - headroom(leaving)) } : {}),
			});
			auto.lastSwitchAt[providerId] = now;
			if (leaving) {
				auto.lastLeft[providerId] = { id: leaving.id, headroom: headroom(leaving) };
			}
			reports.push({
				provider: providerId,
				outcome: 'switched',
				detail: `switched to ${result.to}`,
				to: result.to,
			});
		} catch (error) {
			reports.push({
				provider: providerId,
				outcome: 'blocked',
				detail: (error as Error).message,
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
