import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TickReport } from './auto.ts';
import { acquireLock, readJsonLoose, writeJsonAtomic } from './fs.ts';
import { logEvent } from './log.ts';
import { guardPath, hotseatHome } from './paths.ts';
import { loadSettings, type Settings } from './settings.ts';
import { holdSwitch } from './switch-lock.ts';
import { PROVIDER_IDS, type ProviderId, type State } from './types.ts';

const MINUTE = 60_000;
/** A helper whose transcript has been silent this long is taken to have crashed. */
const SILENT_MS = 30 * MINUTE;
const RESERVATION_MS = 120_000;
const SAMPLE_KEEP_MS = 3 * 60 * MINUTE;
const HOOK_LOCK_MS = 1_000;
const NAMES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };

export interface Reservation {
	sessionId: string;
	at: number;
	toolUseId?: string;
	/** Set when the call resumes a finished helper, which keeps its original toolUseId. */
	agentId?: string;
}

export interface Sample {
	t: number;
	provider: ProviderId;
	accountId: string;
	percent: number;
	resetsAt?: string;
}

export interface GuardState {
	version: 1;
	reservations: Reservation[];
	samples: Sample[];
	brakes: Partial<Record<ProviderId, { at: number; points: number }>>;
}

function emptyGuard(): GuardState {
	return { version: 1, reservations: [], samples: [], brakes: {} };
}

export async function loadGuard(): Promise<GuardState> {
	const stored = await readJsonLoose<Partial<GuardState>>(guardPath());
	return {
		...emptyGuard(),
		...(stored ?? {}),
		version: 1,
		reservations: Array.isArray(stored?.reservations) ? stored.reservations : [],
		samples: Array.isArray(stored?.samples) ? stored.samples : [],
		brakes: stored?.brakes && typeof stored.brakes === 'object' ? stored.brakes : {},
	};
}

export async function updateGuard<T>(
	change: (state: GuardState) => T | Promise<T>,
	timeoutMs = 5_000,
): Promise<T> {
	const lock = await acquireLock(hotseatHome(), timeoutMs, 'guard.lock');
	try {
		const state = await loadGuard();
		const result = await change(state);
		await writeJsonAtomic(guardPath(), state, 0o600);
		return result;
	} finally {
		await lock.release();
	}
}

interface Helpers {
	count: number;
	toolUseIds: Set<string>;
	running: Set<string>;
	finished: Set<string>;
}

async function mtimeOf(path: string): Promise<number | null> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Claude Code writes `<project>/<session>/subagents/agent-<id>.meta.json` when
 * a helper starts and adds `"finished": true` when it ends. A record without
 * it counts unless its transcript has been silent for 30 minutes.
 */
export async function runningHelpers(
	sessionId: string,
	transcriptPath: string,
	now: number,
): Promise<Helpers> {
	const helpers: Helpers = {
		count: 0,
		toolUseIds: new Set(),
		running: new Set(),
		finished: new Set(),
	};
	const dir = join(dirname(transcriptPath), sessionId, 'subagents');
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return helpers;
	}
	for (const name of names) {
		const match = /^agent-(.+)\.meta\.json$/.exec(name);
		if (!match?.[1]) continue;
		const id = match[1];
		const meta = await readJsonLoose<{ finished?: boolean; toolUseId?: string }>(join(dir, name));
		if (!meta) continue;
		if (typeof meta.toolUseId === 'string') helpers.toolUseIds.add(meta.toolUseId);
		if (meta.finished === true) {
			helpers.finished.add(id);
			continue;
		}
		const touched =
			(await mtimeOf(join(dir, `agent-${id}.jsonl`))) ?? (await mtimeOf(join(dir, name)));
		if (touched !== null && now - touched < SILENT_MS) {
			helpers.count += 1;
			helpers.running.add(id);
		}
	}
	return helpers;
}

interface HookPayload {
	session_id?: unknown;
	transcript_path?: unknown;
	tool_name?: unknown;
	tool_use_id?: unknown;
	agent_id?: unknown;
	tool_input?: { to?: unknown } | null;
}

function deny(reason: string): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	});
}

function brakeReason(points: number, minutes: number): string {
	return `Hotseat brake is on: Claude used ${points} points of its weekly limit in ${minutes} minutes. New helpers are paused; tell the user.`;
}

/**
 * Decides one Claude Code PreToolUse call. Returns '' to allow it, or the
 * JSON that refuses it. Any failure of its own allows the call.
 */
export async function runHook(stdin: string, now = Date.now()): Promise<string> {
	let tool = '';
	try {
		const payload = JSON.parse(stdin) as HookPayload;
		tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
		if (tool !== 'Agent' && tool !== 'Task' && tool !== 'SendMessage') return '';
		const sessionId = String(payload.session_id ?? '');
		const transcript = String(payload.transcript_path ?? '');
		const toolUseId = String(payload.tool_use_id ?? '');
		if (!sessionId || !transcript) return '';
		const settings = await loadSettings();
		const helpers = await runningHelpers(sessionId, transcript, now);

		let resumes: string | undefined;
		if (tool === 'SendMessage') {
			const to = payload.tool_input?.to;
			if (typeof to !== 'string' || !helpers.finished.has(to)) return '';
			resumes = to;
		}
		const fromHelper = typeof payload.agent_id === 'string' && payload.agent_id.length > 0;
		if (fromHelper) {
			const reason =
				'Hotseat limit: helpers may not start their own helpers. Do this piece yourself.';
			await logEvent('hook-deny', { tool, sessionId, reason: 'nested' }, now);
			return deny(reason);
		}

		const verdict = await updateGuard((state) => {
			const brake = state.brakes.claude;
			if (brake) return { reason: brakeReason(brake.points, settings.brakeMinutes), count: 0 };
			state.reservations = state.reservations.filter(
				(reservation) =>
					now - reservation.at < RESERVATION_MS &&
					!(reservation.toolUseId && helpers.toolUseIds.has(reservation.toolUseId)) &&
					!(reservation.agentId && helpers.running.has(reservation.agentId)),
			);
			const pending = state.reservations.filter((r) => r.sessionId === sessionId).length;
			const count = helpers.count + pending;
			if (count >= settings.guardChatAgents) {
				return {
					reason: `Hotseat limit: this chat already has ${count} helpers running (limit ${settings.guardChatAgents}). Do this piece yourself, or wait for one to finish and then start the next. Do not retry in a loop.`,
					count,
				};
			}
			state.reservations.push({
				sessionId,
				at: now,
				...(resumes ? { agentId: resumes } : { toolUseId }),
			});
			return { reason: null, count };
		}, HOOK_LOCK_MS);

		if (verdict.reason) {
			await logEvent(
				'hook-deny',
				{ tool, sessionId, running: verdict.count, reason: verdict.reason },
				now,
			);
			return deny(verdict.reason);
		}
		await logEvent(
			'hook-allow',
			{ tool, sessionId, running: verdict.count, ...(resumes ? { resumes } : {}) },
			now,
		);
		return '';
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await logEvent(
			message.includes('timed out waiting for lock') ? 'hook-lock-timeout' : 'hook-error',
			{ tool, message },
			now,
		);
		return '';
	}
}

function sameWeek(a: Sample, b: Sample): boolean {
	if (a.resetsAt === undefined || b.resetsAt === undefined) return a.resetsAt === b.resetsAt;
	return Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) <= 60 * MINUTE;
}

/** Weekly-limit points the provider's accounts rose by between `since` and `now`. */
export function burnPoints(
	samples: Sample[],
	provider: ProviderId,
	since: number,
	now: number,
): number {
	const byAccount = new Map<string, Sample[]>();
	for (const sample of samples) {
		if (sample.provider !== provider || sample.t < since || sample.t > now) continue;
		const list = byAccount.get(sample.accountId) ?? [];
		list.push(sample);
		byAccount.set(sample.accountId, list);
	}
	let points = 0;
	for (const list of byAccount.values()) {
		list.sort((a, b) => a.t - b.t);
		for (let i = 1; i < list.length; i++) {
			const before = list[i - 1];
			const after = list[i];
			if (before && after && sameWeek(before, after))
				points += Math.max(0, after.percent - before.percent);
		}
	}
	return Math.round(points * 10) / 10;
}

function samplesFrom(state: State): Sample[] {
	const samples: Sample[] = [];
	for (const provider of PROVIDER_IDS) {
		for (const account of state.providers[provider]?.accounts ?? []) {
			const week = account.usage?.windows.find((window) => window.label === 'week');
			const t = Date.parse(account.usage?.fetchedAt ?? '');
			if (!week || !Number.isFinite(t)) continue;
			samples.push({
				t,
				provider,
				accountId: account.id,
				percent: week.percent,
				...(week.resetsAt ? { resetsAt: week.resetsAt } : {}),
			});
		}
	}
	return samples;
}

function brakeDetail(provider: ProviderId, points: number, minutes: number): string {
	return `brake: ${NAMES[provider]} used ${points} points of its weekly limit in ${minutes} minutes, so Hotseat stopped switching its accounts and new helpers are refused. It clears itself when spending calms down, or run "hotseat guard resume".`;
}

/**
 * Records this pass's readings and trips or clears each provider's brake.
 * A new brake is published under that provider's switch lock, so it never
 * lands in the middle of a switch.
 */
export async function applyBrake(
	state: State,
	settings: Settings,
	now: number,
): Promise<TickReport[]> {
	const fresh = samplesFrom(state);
	const cleared: Record<string, unknown>[] = [];
	const tripping = await updateGuard((guard) => {
		for (const sample of fresh) {
			const last = guard.samples
				.filter((s) => s.provider === sample.provider && s.accountId === sample.accountId)
				.reduce((latest, s) => Math.max(latest, s.t), Number.NEGATIVE_INFINITY);
			if (sample.t > last) guard.samples.push(sample);
		}
		guard.samples = guard.samples.filter((s) => now - s.t <= SAMPLE_KEEP_MS);
		const since = now - settings.brakeMinutes * MINUTE;
		const trips: { provider: ProviderId; points: number }[] = [];
		for (const provider of PROVIDER_IDS) {
			const points = burnPoints(guard.samples, provider, since, now);
			const brake = guard.brakes[provider];
			if (settings.brakePoints === 0) {
				if (brake) {
					delete guard.brakes[provider];
					cleared.push({ provider, why: 'turned off' });
				}
				continue;
			}
			if (brake) {
				if (points < settings.brakePoints / 2 && now - brake.at >= settings.brakeMinutes * MINUTE) {
					delete guard.brakes[provider];
					cleared.push({ provider, points, why: 'spending calmed down' });
				}
				continue;
			}
			if (points >= settings.brakePoints && (state.providers[provider]?.accounts.length ?? 0) > 0) {
				trips.push({ provider, points });
			}
		}
		return trips;
	});
	for (const event of cleared) await logEvent('brake-clear', event, now);
	for (const { provider, points } of tripping) {
		const held = await holdSwitch(provider);
		try {
			await updateGuard((guard) => {
				if (!guard.brakes[provider]) guard.brakes[provider] = { at: now, points };
			});
		} finally {
			await held.release();
		}
		await logEvent('brake-trip', { provider, points, minutes: settings.brakeMinutes }, now);
	}
	const brakes = (await loadGuard()).brakes;
	return PROVIDER_IDS.flatMap((provider) => {
		const brake = brakes[provider];
		return brake
			? [
					{
						provider,
						outcome: 'blocked' as const,
						detail: brakeDetail(provider, brake.points, settings.brakeMinutes),
					},
				]
			: [];
	});
}

export async function resumeBrake(provider: ProviderId | 'all'): Promise<ProviderId[]> {
	const cleared = await updateGuard((guard) => {
		const names = provider === 'all' ? PROVIDER_IDS : [provider];
		const removed = names.filter((name) => guard.brakes[name] !== undefined);
		for (const name of removed) delete guard.brakes[name];
		return removed;
	});
	for (const name of cleared) await logEvent('brake-resume', { provider: name });
	return cleared;
}

/** Lines for `hotseat guard status`. */
export async function guardStatus(now = Date.now()): Promise<string[]> {
	const settings = await loadSettings();
	const guard = await loadGuard();
	const since = now - settings.brakeMinutes * MINUTE;
	return PROVIDER_IDS.map((provider) => {
		const burn = burnPoints(guard.samples, provider, since, now);
		const brake = guard.brakes[provider];
		const state = brake
			? `brake ON since ${new Date(brake.at).toLocaleString()} (${brake.points} points)`
			: 'brake off';
		return `${NAMES[provider]}: ${burn} points in the last ${settings.brakeMinutes} min (brake at ${settings.brakePoints || 'off'}) - ${state}`;
	}).concat(`Helpers per chat: at most ${settings.guardChatAgents}; helpers may not start helpers`);
}
