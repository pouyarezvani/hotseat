import { randomUUID } from 'node:crypto';
import {
	currentResets,
	failedReading,
	liveIdentity,
	loadCache,
	PROVIDERS,
	readAgainSoon,
	recordAfterReset,
	withStoredDeadlines,
} from './collect.ts';
import { publishState } from './enroll.ts';
import { ResetNotSent, ResetRefused } from './errors.ts';
import { acquireLock } from './fs.ts';
import { logEvent } from './log.ts';
import { hotseatHome } from './paths.ts';
import { loadRegistry } from './registry.ts';
import { renewSaved } from './renew.ts';
import {
	cutOff,
	IN_FLIGHT_MS,
	loadSent,
	SETTLE_MS,
	type SentUse,
	saveSent,
	sentKey,
} from './reset-journal.ts';
import { sessionLogin, sessionRunning } from './session.ts';
import { holdSwitch } from './switch-lock.ts';
import type {
	AccountRecord,
	Credential,
	LimitReset,
	Provider,
	ProviderId,
	ResetUse,
	UsageSnapshot,
} from './types.ts';

/**
 * A good reading of the account's resets, made with its confirmed login and
 * taken long enough after the use to show it.
 */
function settles(snapshot: UsageSnapshot | undefined, use: SentUse): boolean {
	if (!snapshot || snapshot.error !== undefined || snapshot.limitResets === undefined) return false;
	if (snapshot.limitResetsIncomplete) return false;
	const readAt = snapshot.limitResetsReadAt ? Date.parse(snapshot.limitResetsReadAt) : Number.NaN;
	return Number.isFinite(readAt) && readAt >= use.at + SETTLE_MS;
}

/** Throws unless the service itself says this login is the account's own. */
async function confirmOwner(
	provider: Provider,
	account: AccountRecord,
	credential: Credential,
): Promise<Credential> {
	const who = await provider.identify(credential).catch(() => undefined);
	if (!who?.confirmed) {
		throw new Error(
			`could not confirm with ${provider.displayName} that the login for ${account.email} is still its own - try again in a moment`,
		);
	}
	if (who.email.toLowerCase() !== account.email.toLowerCase()) {
		throw new Error(
			`the login hotseat holds for ${account.email} is signed in as ${who.email} - sign in to ${account.email} again first`,
		);
	}
	return credential;
}

/**
 * The login to act as an account with, confirmed by the service to be that
 * account's: the one in use when it is this account's, the one a terminal
 * running as it holds, or else its saved login, renewed if it is due.
 */
async function loginFor(
	provider: Provider,
	account: AccountRecord,
	now: number,
): Promise<Credential> {
	const installed = await provider.readAgentCredential().catch(() => null);
	if (installed) {
		const who = await liveIdentity(provider, installed, await loadRegistry(), await loadCache());
		if (who?.email.toLowerCase() === account.email.toLowerCase()) {
			const expires = provider.expiresAt?.(installed);
			if (expires !== undefined && expires <= now) {
				throw new Error(
					`the login in use for ${account.email} has expired - let ${provider.displayName} renew it, then try again`,
				);
			}
			return confirmOwner(provider, account, installed);
		}
	}
	if (await sessionRunning(provider, account)) {
		const owned = await sessionLogin(provider, account);
		if (owned) return confirmOwner(provider, account, owned);
	}
	const saved = await renewSaved(provider, account);
	if (!saved) throw new Error(`${account.email} has no saved login`);
	return confirmOwner(provider, account, saved);
}

/** A refusal the reset endpoint gave outright, after which the reset is known not to have been used. */
function refusedOutright(error: unknown): boolean {
	if (error instanceof ResetNotSent) return true;
	if (!(error instanceof ResetRefused) || error.status === undefined) return false;
	return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

type UseResult = { reset: LimitReset; outcome: ResetUse; retried: boolean };

/**
 * Uses one of an account's free limit resets: the first of those named, in
 * the order named, that can be used now, or the first of all when none is
 * named. Only a reset the account was last seen to hold is spent, judged on a
 * reading made just now with the login confirmed to be its own, and one use
 * runs at a time. Every use is recorded before it is sent. One whose answer
 * was lost, or that was cut off, stays recorded until such a reading taken
 * long enough after it settles it: asked for again before then, it is sent
 * with the same request id, so the service treats it as the same use, and no
 * other reset of the account is used. A reset the service just used is not
 * used again before such a reading either.
 */
export async function useLimitReset(
	providerId: ProviderId,
	account: AccountRecord,
	resetIds: string | readonly string[] | undefined,
	providers: Record<ProviderId, Provider> = PROVIDERS,
	now: () => number = Date.now,
): Promise<UseResult> {
	const provider = providers[providerId];
	if (!provider.useReset) throw new Error(`${provider.displayName} has no limit resets`);
	const apply = provider.useReset.bind(provider);
	const wanted = typeof resetIds === 'string' ? [resetIds] : resetIds;
	if (
		wanted !== undefined &&
		(wanted.length === 0 || wanted.some((id) => id.trim().length === 0))
	) {
		throw new Error(
			'name a reset by its id, or leave it out to use the first that can be used now',
		);
	}
	const key = sentKey(providerId, account);
	const lock = await acquireLock(hotseatHome(), 60_000, 'reset.lock');
	try {
		let sent = (await loadSent())[key] ?? [];
		if (sent.some((use) => use.inFlight)) {
			sent = cutOff(sent, now());
			await saveSent(key, sent);
		}
		const lastUse = Math.max(0, ...sent.map((use) => use.at));
		await publishState({ providers, now: now(), clock: now }).catch(() => undefined);
		const credential = await loginFor(provider, account, now());
		const readStart = now();
		const fresh = await provider.fetchUsage(credential).catch(() => undefined);
		if (!fresh || fresh.error !== undefined || fresh.windows.length === 0) {
			throw new Error(
				`could not read ${account.email} with its own login just now, so no reset is used - try again in a moment`,
			);
		}
		const open = sent.filter((use) => !settles(fresh, use));
		if (open.length !== sent.length) await saveSent(key, open);
		sent = open;

		const cached = (await loadCache()).entries[account.id]?.snapshot;
		const timed = await withStoredDeadlines(account.id, fresh, lastUse, readStart);
		const basis: UsageSnapshot =
			timed.limitResets === undefined && cached?.limitResets
				? { ...timed, limitResets: cached.limitResets }
				: timed;
		const held = currentResets(basis, now());
		const justUsed = new Set(sent.filter((use) => use.used).map((use) => use.resetId));
		const lost = sent.find((use) => use.used === undefined);
		const lostError = (use: SentUse) =>
			new Error(
				`a reset sent for ${account.email} at ${new Date(use.at).toLocaleTimeString()} got no answer - hotseat refresh shows whether it was used; try again a few minutes after it was sent`,
			);
		const usable = (entry: LimitReset): boolean =>
			entry.blocked === undefined && entry.id.trim().length > 0 && !justUsed.has(entry.id);
		const candidates = wanted
			? wanted.flatMap((id) => held.filter((entry) => entry.id === id))
			: held;
		if (wanted && candidates.length === 0) {
			throw new Error(
				`${account.email} holds no reset "${wanted.join('", "')}" - hotseat status --json lists the ones it has, with their ids`,
			);
		}
		const order = [
			...candidates.filter((entry) => entry.id === lost?.resetId && usable(entry)),
			...candidates.filter((entry) => entry.id !== lost?.resetId && usable(entry)),
		];
		const first = order[0];
		if (!first) {
			const shown = candidates[0];
			if (!shown) throw new Error(`${account.email} holds no reset that can be used now`);
			if (justUsed.has(shown.id)) {
				throw new Error(
					`the ${shown.title} was just used - hotseat refresh shows what is left a few minutes after`,
				);
			}
			throw new Error(
				`the ${shown.title} cannot be used right now: ${shown.blocked ?? 'it has no id'}`,
			);
		}
		if (lost && lost.resetId !== first.id) throw lostError(lost);

		// Each use is sent and recorded while holding the switch lock. Reading
		// the accounts takes that lock too, so the board is published after it
		// is released.
		const switching = await holdSwitch(providerId);
		let ended: { result: UseResult } | { error: unknown };
		try {
			ended = { result: await sendInTurn() };
		} catch (error) {
			ended = { error };
		} finally {
			await switching.release();
		}
		await publishState({ providers, now: now(), clock: now }).catch(() => undefined);
		if ('error' in ended) throw ended.error;
		return ended.result;

		// Each is tried in turn while the service turns them down outright on a
		// first try; a use, a lost answer, or a second try ends it.
		async function sendInTurn(): Promise<UseResult> {
			let declined: { reset: LimitReset; outcome?: ResetUse; error?: unknown } | undefined;
			for (const reset of order) {
				const retry = lost?.resetId === reset.id ? lost : undefined;
				// Each is judged as it stands when its turn comes.
				const current = currentResets(basis, now()).find((entry) => entry.id === reset.id);
				if (!current || !usable(current)) {
					if (retry) throw lostError(retry);
					continue;
				}
				const requestId = retry?.requestId ?? randomUUID();
				const others = sent.filter((entry) => entry !== retry);
				await saveSent(key, [
					...others,
					{
						resetId: reset.id,
						title: reset.title,
						requestId,
						at: now() + IN_FLIGHT_MS,
						inFlight: true,
					},
				]);
				const done = (): SentUse => ({
					resetId: reset.id,
					title: reset.title,
					requestId,
					at: now(),
				});

				let outcome: ResetUse;
				try {
					outcome = await apply(credential, reset.id, requestId, () => {
						const latest = currentResets(basis, now()).find((entry) => entry.id === reset.id);
						return latest !== undefined && usable(latest);
					});
				} catch (error) {
					if (retry && error instanceof ResetNotSent) {
						// Not sent again: the earlier attempt stays as it was, still unsettled.
						await saveSent(key, [...others, retry]).catch(() => undefined);
						throw lostError(retry);
					}
					const known = !retry && refusedOutright(error);
					const ended = done();
					await saveSent(key, known ? others : [...others, ended]).catch(() => undefined);
					await logEvent('reset-failed', {
						provider: providerId,
						account: account.email,
						reset: reset.title,
						id: reset.id,
						uncertain: !known,
						error: error instanceof Error ? error.message : String(error),
					});
					if (known) {
						sent = others;
						declined = { reset, error };
						continue;
					}
					await recordAfterReset(account.id, undefined, ended.at).catch(() => undefined);
					throw new Error(
						`the ${reset.title} was sent but no answer came back, so it may have been used - hotseat refresh shows whether it was; asking again for the same reset sends the same request`,
					);
				}

				const ended = done();
				const recorded = outcome.used
					? [...others, { ...ended, used: true as const }]
					: retry
						? [...others, ended]
						: others;
				await saveSent(key, recorded).catch(() => undefined);
				await logEvent('reset-used', {
					provider: providerId,
					account: account.email,
					reset: reset.title,
					id: reset.id,
					used: outcome.used,
					...(retry ? { retried: true } : {}),
					...(outcome.refused ? { refused: outcome.refused } : {}),
				});
				if (outcome.used) {
					const readAt = now();
					const after = await provider
						.fetchUsage(credential)
						.catch((error: unknown) => failedReading(error, readAt, now()));
					await recordAfterReset(account.id, after, ended.at, readAt).catch(() => undefined);
					return { reset, outcome, retried: retry !== undefined };
				}
				if (retry) {
					await readAgainSoon(account.id, now()).catch(() => undefined);
					return { reset, outcome, retried: true };
				}
				sent = others;
				declined = { reset, outcome };
			}
			await readAgainSoon(account.id, now()).catch(() => undefined);
			if (declined?.outcome) {
				return { reset: declined.reset, outcome: declined.outcome, retried: false };
			}
			throw declined?.error ?? new Error(`${account.email} holds no reset that can be used now`);
		}
	} finally {
		await lock.release();
	}
}
