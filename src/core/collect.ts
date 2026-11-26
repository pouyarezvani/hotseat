import { AntigravityProvider } from '../providers/antigravity/index.ts';
import { ClaudeProvider } from '../providers/claude/index.ts';
import { CodexProvider } from '../providers/codex/index.ts';
import { GrokProvider } from '../providers/grok/index.ts';
import { classify, ServiceError } from './errors.ts';
import { acquireLock, readJsonLoose, writeJsonAtomic } from './fs.ts';
import { hotseatHome, usageCachePath } from './paths.ts';
import { accountsFor, loadRegistry } from './registry.ts';
import { RenewalFailed, renewInstalled, renewSaved, replaceEnded } from './renew.ts';
import {
	loadSent,
	releaseCutOff,
	SETTLE_MS,
	type SentUse,
	type SentUses,
	sentKey,
} from './reset-journal.ts';
import { adoptIfNewer, sessionLogin, sessionRunning } from './session.ts';
import { loadSettings } from './settings.ts';
import type {
	AccountRecord,
	AccountState,
	Credential,
	Identity,
	LimitReset,
	Provider,
	ProviderId,
	ProviderState,
	Registry,
	SignedOut,
	State,
	UsageSnapshot,
	UsageWindow,
} from './types.ts';
import { fingerprint, loadCredential } from './vault.ts';
import { fullyAwake } from './wake.ts';

export const PROVIDERS: Record<ProviderId, Provider> = {
	claude: new ClaudeProvider(),
	codex: new CodexProvider(),
	grok: new GrokProvider(),
	antigravity: new AntigravityProvider(),
};

/**
 * How often each account is read. The usage endpoint allows roughly thirty
 * reads an hour per account before it answers 429 for the rest of the hour,
 * so the cadence is the budget spent where it matters: the account in use is
 * read every minute once a switch could be near, every three minutes
 * otherwise, and the others every five. Even an explicit refresh will not
 * re-read an account inside the floor.
 */
export const REREAD_FLOOR_MS = 60_000;
export const ACTIVE_URGENT_MS = 60_000;
export const ACTIVE_CALM_MS = 180_000;
export const CANDIDATE_MS = 300_000;
/** Within this many points of the threshold the account in use is read urgently. */
export const URGENT_BAND_PERCENT = 15;

/** A reading has to move by at least this much between reads to count as moving. */
export const MOVEMENT_PERCENT = 1;

/**
 * The urgent rate alone is over the hourly budget if sustained for an hour,
 * which is why it also requires the number to be moving. Usage climbs in
 * bursts while a session is busy and sits still otherwise, so urgent reads
 * happen exactly when a switch could be seconds away and nowhere else.
 */
export function cadenceFor(input: {
	isActive: boolean;
	usedPercent: number | undefined;
	previousPercent: number | undefined;
	thresholdPercent: number;
}): number {
	if (!input.isActive) return CANDIDATE_MS;
	if (input.usedPercent === undefined) return ACTIVE_CALM_MS;
	const nearThreshold = input.usedPercent >= input.thresholdPercent - URGENT_BAND_PERCENT;
	const moving =
		input.previousPercent === undefined ||
		Math.abs(input.usedPercent - input.previousPercent) >= MOVEMENT_PERCENT;
	return nearThreshold && moving ? ACTIVE_URGENT_MS : ACTIVE_CALM_MS;
}

interface CacheEntry {
	/** The last reading that had numbers, with the error of a later failed read. */
	snapshot: UsageSnapshot;
	/** When the numbers in the snapshot were read. */
	fetchedAtMs: number;
	/** When a read was last tried, successful or not. Cadence counts from here. */
	attemptedAtMs: number;
	previousPercent?: number;
	/** A saved login the service refused to refresh, not tried again until it changes. */
	deadLogin?: string;
	/** When a reset was last used on the account: numbers read before then say nothing about now. */
	resetAtMs?: number;
	/**
	 * The agent's own latest reading of the account, which covers only some of
	 * its limits: laid over the snapshot when shown, while it is the newer.
	 */
	local?: { fetchedAtMs: number; windows: UsageWindow[] };
	/**
	 * When a read of the account, its list of resets included, was asked for
	 * ahead of its turn: the next pass reads it if no attempt came after.
	 */
	readSoonAt?: number;
}

/** The entry's numbers were read before a reset was used on the account. */
function beforeReset(entry: CacheEntry, mark = entry.resetAtMs ?? 0): boolean {
	return entry.fetchedAtMs < mark;
}

/**
 * When a reset was last used on an account, by the record of uses: a use the
 * service answered, one whose answer was lost, or one still marked as being
 * sent, any of which may have happened. The record is written before each use
 * is sent, so it holds even when nothing after the send got to run.
 */
function usedAt(uses: readonly SentUse[] | undefined, inFlight = true): number {
	return Math.max(
		0,
		...(uses ?? []).filter((use) => inFlight || !use.inFlight).map((use) => use.at),
	);
}

/**
 * An entry as shown, before the windows' own resets: its numbers, or none
 * while they are from before a reset, with the agent's own newer reading of
 * some limits laid over them.
 */
function shownOf(entry: CacheEntry, mark = entry.resetAtMs ?? 0): UsageSnapshot {
	const before = beforeReset(entry, mark) && entry.snapshot.windows.length > 0;
	const local = entry.local;
	if (!local || local.fetchedAtMs <= entry.fetchedAtMs || local.fetchedAtMs < mark) {
		return before ? awaitingRead(entry.snapshot) : entry.snapshot;
	}
	const keys = new Set(local.windows.map((window) => window.key));
	return {
		...entry.snapshot,
		fetchedAt: new Date(local.fetchedAtMs).toISOString(),
		windows: [
			...local.windows,
			...(before ? [] : entry.snapshot.windows.filter((window) => !keys.has(window.key))),
		],
	};
}

/** An entry as shown now. */
function presented(entry: CacheEntry, now: number, mark = entry.resetAtMs ?? 0): UsageSnapshot {
	const snapshot = shownOf(entry, mark);
	return { ...snapshot, windows: snapshot.windows.map((window) => resetBy(window, now)) };
}

const AWAITING_READ = 'reading it again after a reset';

/** A reading from before a reset, as shown until the account is read again: no numbers, and why. */
function awaitingRead(snapshot: UsageSnapshot): UsageSnapshot {
	return { ...snapshot, windows: [], error: AWAITING_READ, errorKind: 'other' };
}

/**
 * Two entries for one account, as one: the newer numbers, and what came of
 * the later attempt, each taken on its own. Numbers that may predate a reset
 * (`oursEligible` false) never replace the stored ones.
 */
function merged(
	stored: CacheEntry,
	ours: CacheEntry,
	oursEligible: boolean,
	listEligible = oursEligible,
): CacheEntry {
	const oursNumbers =
		oursEligible &&
		(ours.fetchedAtMs > stored.fetchedAtMs ||
			(ours.fetchedAtMs === stored.fetchedAtMs && ours.attemptedAtMs >= stored.attemptedAtMs));
	const oursAttempt =
		ours.attemptedAtMs > stored.attemptedAtMs ||
		(ours.attemptedAtMs === stored.attemptedAtMs && oursNumbers);
	const oursList =
		listEligible &&
		(listAt(ours) > listAt(stored) || (listAt(ours) === listAt(stored) && oursNumbers));
	const numbers = oursNumbers ? ours : stored;
	const attempt = oursAttempt ? ours : stored;
	const {
		limitResets: _list,
		limitResetsReadAt: _listAt,
		limitResetsIncomplete: _incomplete,
		limitResetsStale: _stale,
		...figures
	} = withoutOutcome(numbers.snapshot);
	const { deadLogin: _dead, resetAtMs: _mark, local: _local, readSoonAt: _soon, ...base } = numbers;
	const resetAtMs = Math.max(stored.resetAtMs ?? 0, ours.resetAtMs ?? 0);
	const readSoonAt = Math.max(stored.readSoonAt ?? 0, ours.readSoonAt ?? 0);
	const local =
		(ours.local?.fetchedAtMs ?? -1) > (stored.local?.fetchedAtMs ?? -1) ? ours.local : stored.local;
	return {
		...base,
		snapshot: {
			...figures,
			...listOf((oursList ? ours : stored).snapshot),
			...outcomeOf(attempt.snapshot),
		},
		attemptedAtMs: attempt.attemptedAtMs,
		...(attempt.deadLogin !== undefined ? { deadLogin: attempt.deadLogin } : {}),
		...(resetAtMs > 0 ? { resetAtMs } : {}),
		...(readSoonAt > 0 ? { readSoonAt } : {}),
		...(local ? { local } : {}),
	};
}

/** When the entry's list of resets was read: -1 when it holds none, 0 when it is not known. */
function listAt(entry: CacheEntry): number {
	if (entry.snapshot.limitResets === undefined) return -1;
	const read = entry.snapshot.limitResetsReadAt;
	const at = read ? Date.parse(read) : Number.NaN;
	return Number.isFinite(at) ? at : 0;
}

/** A reading's list of resets and what is known of it. */
function listOf(snapshot: UsageSnapshot): Partial<UsageSnapshot> {
	const { limitResets, limitResetsReadAt, limitResetsIncomplete, limitResetsStale } = snapshot;
	return {
		...(limitResets !== undefined ? { limitResets } : {}),
		...(limitResetsReadAt !== undefined ? { limitResetsReadAt } : {}),
		...(limitResetsIncomplete ? { limitResetsIncomplete } : {}),
		...(limitResetsStale ? { limitResetsStale } : {}),
	};
}

/** A reading whose list of resets is not to be reused, though it is kept, with its time, to fall back on. */
function listToRenew(snapshot: UsageSnapshot): UsageSnapshot {
	return snapshot.limitResets === undefined ? snapshot : { ...snapshot, limitResetsStale: true };
}

/** What came of the latest attempt to read, apart from the numbers. */
function outcomeOf(snapshot: UsageSnapshot): Partial<UsageSnapshot> {
	const { error, errorKind, failedReads, retryAt } = snapshot;
	return {
		...(error !== undefined ? { error } : {}),
		...(errorKind !== undefined ? { errorKind } : {}),
		...(failedReads !== undefined ? { failedReads } : {}),
		...(retryAt !== undefined ? { retryAt } : {}),
	};
}

function withoutOutcome(snapshot: UsageSnapshot): UsageSnapshot {
	const { error: _e, errorKind: _k, failedReads: _f, retryAt: _r, ...rest } = snapshot;
	return rest;
}

const UNCONFIRMED = 'could not confirm which login is in use - trying again shortly';
const SIGNED_OUT = 'signed out - ';

/** An account's numbers, said to be from a login that could not be confirmed. */
function unconfirmedOf(snapshot: UsageSnapshot): UsageSnapshot {
	return noted(snapshot, UNCONFIRMED);
}

/** An account's numbers, with what the board says of the login in use in place of what a read said. */
function noted(snapshot: UsageSnapshot, note: string): UsageSnapshot {
	return { ...withoutOutcome(snapshot), error: note, errorKind: 'other' };
}

/** Whether a message is the board's own word on the login in use, rather than what a read said. */
function isBoardNote(error: string | undefined): error is string {
	return error === UNCONFIRMED || (error?.startsWith(SIGNED_OUT) ?? false);
}

/** What the board says when the installed login holds nothing to sign in with. */
function signedOutNote(provider: Provider, out: SignedOut, waitingForWake: boolean): string {
	if (!out.ended) {
		return `${SIGNED_OUT}nothing is signed in to ${provider.displayName}; switch to an account or sign in`;
	}
	if (waitingForWake)
		return `${SIGNED_OUT}its saved login goes back in once the Mac is fully awake`;
	return out.reason
		? `${SIGNED_OUT}the login ${out.reason}; sign in to it again`
		: `${SIGNED_OUT}${provider.displayName} stopped renewing the login; sign in to it again`;
}

/**
 * The saved account a login the agent cleared belongs to: the one with the
 * same account id, when the login still names one, else the account last put in use.
 */
function ownerOfCleared(
	provider: Provider,
	records: AccountRecord[],
	cleared: Credential,
	activeId: string | undefined,
): AccountRecord | undefined {
	const account = provider.accountOf?.(cleared);
	if (account === undefined) return records.find((record) => record.id === activeId);
	return records.find(
		(record) => record.login !== undefined && provider.accountOf?.(record.login) === account,
	);
}

/** How long to wait after being told to slow down, when the service does not say. */
export const THROTTLE_BACKOFF_MS = 10 * 60_000;

/** Shown on a login due for renewal while the Mac is only half awake. */
const WAITING_FOR_WAKE = 'waiting for the Mac to wake before renewing this login';

interface LiveIdentity {
	fingerprint: string;
	email: string;
	plan?: string;
	accountId?: string;
	/** This answer came from asking the service, so it is as complete as it gets. */
	asked?: true;
}

interface UsageCache {
	version: 2;
	entries: Record<string, CacheEntry>;
	/** Which account the installed login belongs to, keyed by service. */
	identities: Partial<Record<ProviderId, LiveIdentity>>;
}

export async function loadCache(): Promise<UsageCache> {
	const stored = await readJsonLoose<Partial<UsageCache>>(usageCachePath());
	if (stored?.version !== 2) return { version: 2, entries: {}, identities: {} };
	return { version: 2, entries: stored.entries ?? {}, identities: stored.identities ?? {} };
}

/**
 * Records that a reset may have been used on an account, as of `resetAt`: when
 * the service answered, or when the attempt ended without one. A good reading
 * begun at `readAt`, after that, is kept as the account's numbers unless a
 * newer one from after the reset is already stored; without one, the numbers
 * from before are set aside until the account is read again. Either way
 * nothing read before the reset, here or by another pass, replaces what
 * follows it.
 */
export async function recordAfterReset(
	accountId: string,
	reading: UsageSnapshot | undefined,
	resetAt: number,
	readAt = resetAt,
): Promise<void> {
	const lock = await acquireLock(hotseatHome(), 10_000, 'usage.lock');
	try {
		const cache = await loadCache();
		const entry = cache.entries[accountId];
		const kept = Math.max(resetAt, entry?.resetAtMs ?? 0);
		if (reading && reading.error === undefined && reading.windows.length > 0) {
			const after = entry && !beforeReset(entry, kept) ? entry.snapshot : undefined;
			const ours: CacheEntry = {
				snapshot: {
					...carryResets(reading, after, readAt),
					...resetListOf(reading, entry?.snapshot),
				},
				fetchedAtMs: readAt,
				attemptedAtMs: readAt,
				resetAtMs: kept,
				...(entry?.previousPercent !== undefined ? { previousPercent: entry.previousPercent } : {}),
			};
			cache.entries[accountId] = entry ? merged(entry, ours, true) : ours;
		} else if (entry) {
			// A stored reading counts as after the reset only when strictly later.
			const resetAtMs = entry.fetchedAtMs > resetAt ? kept : Math.max(kept, entry.fetchedAtMs + 1);
			// A read that failed is the latest attempt, with its wait, unless one came after.
			const failed = reading?.error !== undefined && readAt >= entry.attemptedAtMs;
			cache.entries[accountId] = {
				...entry,
				...(failed && reading
					? {
							snapshot: {
								...withoutOutcome(entry.snapshot),
								...outcomeOf(reading),
								...counted(reading, entry.snapshot),
							},
							attemptedAtMs: readAt,
						}
					: {}),
				resetAtMs,
				readSoonAt: Math.max(entry.readSoonAt ?? 0, resetAt),
			};
		} else {
			// Nothing read yet: what is known is the reset, and how the read after it went.
			const failed = reading?.error !== undefined;
			cache.entries[accountId] = {
				snapshot: {
					fetchedAt: new Date(readAt).toISOString(),
					windows: [],
					...(failed && reading ? { ...outcomeOf(reading), ...counted(reading, undefined) } : {}),
				},
				fetchedAtMs: 0,
				attemptedAtMs: failed ? readAt : 0,
				resetAtMs: resetAt,
				readSoonAt: resetAt,
			};
		}
		await writeJsonAtomic(usageCachePath(), cache, 0o600);
	} finally {
		await lock.release();
	}
}

/**
 * A fresh reading, begun at `readAt`, with any reset time it left out taken
 * from the stored reading, when that one is from after the account's last
 * reset (`mark`) and the time was still ahead when the reading began.
 */
export async function withStoredDeadlines(
	accountId: string,
	fresh: UsageSnapshot,
	mark: number,
	readAt: number,
): Promise<UsageSnapshot> {
	const entry = (await loadCache()).entries[accountId];
	if (!entry || beforeReset(entry, Math.max(mark, entry.resetAtMs ?? 0))) return fresh;
	return carryResets(fresh, entry.snapshot, readAt);
}

/** An auth failure counted on top of those before it, as the collector counts them. */
function counted(
	failure: UsageSnapshot,
	before: UsageSnapshot | undefined,
): Partial<UsageSnapshot> {
	return failure.errorKind === 'auth' ? { failedReads: (before?.failedReads ?? 0) + 1 } : {};
}

/**
 * A read that failed, as a reading that says why, and when to try again if
 * the service said: begun at `at`, answered at `answeredAt`, from which any
 * wait is counted.
 */
export function failedReading(error: unknown, at: number, answeredAt = at): UsageSnapshot {
	const retryAfterMs =
		error instanceof ServiceError && error.retryAfterMs !== undefined
			? error.retryAfterMs
			: undefined;
	const kind = classify(error);
	return {
		fetchedAt: new Date(at).toISOString(),
		windows: [],
		error: plainError(error),
		errorKind: kind,
		...(kind === 'throttled'
			? { retryAt: new Date(answeredAt + (retryAfterMs ?? THROTTLE_BACKOFF_MS)).toISOString() }
			: {}),
	};
}

/**
 * An account's usage as last shown, or newer: what the cache holds when it
 * was read after what is shown, or when a reset was used after it was read.
 */
export async function freshUsage(
	account: Pick<AccountState, 'id' | 'email'>,
	provider: ProviderId,
	shown: UsageSnapshot | undefined,
	now: number,
): Promise<UsageSnapshot | undefined> {
	const entry = (await loadCache()).entries[account.id];
	const uses = await loadSent().catch(() => null);
	const mark = Math.max(entry?.resetAtMs ?? 0, usedAt(uses?.[sentKey(provider, account)]));
	const shownAt = shown ? Date.parse(shown.fetchedAt) : Number.NaN;
	const at = Number.isFinite(shownAt) ? shownAt : 0;
	if (!shown) return entry ? presented(entry, now, mark) : undefined;
	const asOfNow = (usage: UsageSnapshot): UsageSnapshot => ({
		...usage,
		windows: usage.windows.map((window) => resetBy(window, now)),
	});
	let usage: UsageSnapshot;
	if (!entry) {
		usage = asOfNow(mark > at ? awaitingRead(shown) : shown);
	} else {
		const view = presented(entry, now, mark);
		const viewAt = Date.parse(view.fetchedAt);
		const shownNewer =
			shown.error !== AWAITING_READ && mark <= at && Number.isFinite(viewAt) && viewAt < at;
		usage = shownNewer ? asOfNow(shown) : withForecastsFrom(view, shown);
	}
	// What is said of the login in use is the board's to say.
	return isBoardNote(shown.error) ? noted(usage, shown.error) : usage;
}

/**
 * A reading with the forecast and trend worked out for each limit of the
 * same reading earlier: same time, and the limit at the same level and reset.
 */
export function withForecastsFrom(
	usage: UsageSnapshot,
	from: UsageSnapshot | undefined,
): UsageSnapshot {
	if (!from || from.fetchedAt !== usage.fetchedAt) return usage;
	return {
		...usage,
		windows: usage.windows.map((window) => {
			if (window.cleared) return window;
			const same = from.windows.find(
				(old) =>
					old.key === window.key &&
					old.percent === window.percent &&
					old.resetsAt === window.resetsAt,
			);
			return same
				? {
						...window,
						...(same.fullAt !== undefined ? { fullAt: same.fullAt } : {}),
						...(same.trend !== undefined ? { trend: same.trend } : {}),
					}
				: window;
		}),
	};
}

/**
 * Has an account read again on the next pass, its list of resets included,
 * while keeping what was last read until then.
 */
export async function readAgainSoon(accountId: string, at = Date.now()): Promise<void> {
	const lock = await acquireLock(hotseatHome(), 10_000, 'usage.lock');
	try {
		const cache = await loadCache();
		const entry = cache.entries[accountId];
		if (!entry) return;
		cache.entries[accountId] = { ...entry, readSoonAt: Math.max(entry.readSoonAt ?? 0, at) };
		await writeJsonAtomic(usageCachePath(), cache, 0o600);
	} finally {
		await lock.release();
	}
}

/**
 * Forgets what was last read for an account, so its next read happens at
 * once. A new login makes the old reading, and any failure recorded against
 * the old login, say nothing about the account any more.
 */
export async function forgetReading(accountId: string): Promise<void> {
	const lock = await acquireLock(hotseatHome(), 10_000, 'usage.lock');
	try {
		const cache = await loadCache();
		if (!(accountId in cache.entries)) return;
		delete cache.entries[accountId];
		await writeJsonAtomic(usageCachePath(), cache, 0o600);
	} finally {
		await lock.release();
	}
}

/**
 * Whose login is installed. Asking the service costs a request, so the answer
 * is kept until the credential changes. When the service cannot be reached,
 * the vault copy of the account hotseat last installed is compared instead:
 * an identical credential is that account, with no request at all.
 */
export async function liveIdentity(
	provider: Provider,
	installed: Credential,
	registry: Registry,
	cache?: UsageCache,
): Promise<Identity | undefined> {
	const print = fingerprint(installed);
	const remembered = cache?.identities[provider.id];
	// An answer an older hotseat remembered, before it knew to keep the account
	// id, is asked for once more: that id is how the agent's own reading is
	// matched to the account. An answer this version asked for is never re-asked.
	if (remembered && remembered.fingerprint === print && remembered.asked) {
		return {
			email: remembered.email,
			...(remembered.plan ? { plan: remembered.plan } : {}),
			...(remembered.accountId ? { accountId: remembered.accountId } : {}),
		};
	}
	const asked = await provider.identify(installed).catch(() => undefined);
	if (asked) {
		if (cache) {
			cache.identities[provider.id] = {
				fingerprint: print,
				email: asked.email,
				asked: true,
				...(asked.plan ? { plan: asked.plan } : {}),
				...(asked.accountId ? { accountId: asked.accountId } : {}),
			};
		}
		return asked;
	}
	if (remembered && remembered.fingerprint === print) {
		return { email: remembered.email, ...(remembered.plan ? { plan: remembered.plan } : {}) };
	}
	// No answer from the service: the installed login is still known when it is
	// exactly one of the saved copies, which hotseat keeps current below.
	// The match is remembered in the identity cache.
	for (const account of accountsFor(registry, provider.id)) {
		const saved = await loadCredential(account).catch(() => null);
		if ((saved && fingerprint(saved) === print) || account.renewedFrom === print) {
			if (cache) {
				cache.identities[provider.id] = {
					fingerprint: print,
					email: account.email,
					...(account.plan ? { plan: account.plan } : {}),
				};
			}
			return { email: account.email, ...(account.plan ? { plan: account.plan } : {}) };
		}
	}
	return undefined;
}

/** What one read attempt came back with, or why it did not. */
interface Attempt {
	usage: UsageSnapshot;
	failure?: { kind: ReturnType<typeof classify>; retryAfterMs?: number; deadLogin?: string };
}

/**
 * Reads one account's usage using its own saved login. Every account is polled,
 * not just the one in use: an account with no reading cannot be compared, so
 * switching would be choosing blind. Never throws: one account that cannot be
 * read must not take the whole board down with it.
 */
async function readUsage(
	provider: Provider,
	account: AccountRecord,
	live: { credential: Credential; email: string } | null,
	now: number,
	deadLogin: string | undefined,
	awake: () => Promise<boolean>,
	previous: UsageSnapshot | undefined,
): Promise<Attempt> {
	const fetchedAt = new Date(now).toISOString();
	const failed = (error: unknown, deadLoginNow?: string): Attempt => ({
		usage: { fetchedAt, windows: [], error: plainError(error) },
		failure: {
			kind: classify(error),
			...(error instanceof ServiceError && error.retryAfterMs !== undefined
				? { retryAfterMs: error.retryAfterMs }
				: {}),
			...(deadLoginNow ? { deadLogin: deadLoginNow } : {}),
		},
	});
	try {
		// The installed credential is the freshest copy for whichever account
		// holds it, because the agent may have rotated its token since it was saved.
		if (live && live.email.toLowerCase() === account.email.toLowerCase()) {
			return { usage: await provider.fetchUsage(live.credential, previous) };
		}
		// An account open in another terminal is read with that terminal's own
		// login, and never refreshed from here: the running agent owns that
		// token now, and a refresh from a stale copy would log it out.
		if (await sessionRunning(provider, account)) {
			const owned = await sessionLogin(provider, account);
			if (owned) return { usage: await provider.fetchUsage(owned, previous) };
		}
		const stored = await loadCredential(account);
		if (!stored) return { usage: { fetchedAt, windows: [], error: 'no saved login' } };
		if (deadLogin !== undefined && deadLogin === fingerprint(stored)) {
			return {
				usage: {
					fetchedAt,
					windows: [],
					error: 'the saved login no longer works - sign in to it again',
				},
				failure: { kind: 'auth', deadLogin },
			};
		}
		if (!(await awake())) {
			// A login still valid is read as it is; one due for renewal waits for
			// the Mac to wake fully, where the new token cannot be lost.
			const expires = provider.expiresAt?.(stored);
			if (expires !== undefined && expires <= now) return failed(new Error(WAITING_FOR_WAKE));
			return { usage: await provider.fetchUsage(stored, previous) };
		}
		let renewed: Credential | null;
		try {
			renewed = await renewSaved(provider, account);
		} catch (error) {
			if (error instanceof RenewalFailed && classify(error) === 'auth') {
				return failed(
					new ServiceError('the saved login no longer works - sign in to it again', 401),
					fingerprint(error.login),
				);
			}
			return failed(error);
		}
		if (!renewed) return { usage: { fetchedAt, windows: [], error: 'no saved login' } };
		return { usage: await provider.fetchUsage(renewed, previous) };
	} catch (error) {
		return failed(error);
	}
}

/** What a failed read says on the board, in words rather than status codes. */
export function plainError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/\b401\b|\b403\b|invalid_grant|revoked/i.test(message))
		return 'the saved login no longer works';
	if (/\b429\b/.test(message)) return 'read too often, waiting a while';
	if (/\b5\d\d\b/.test(message)) return 'the service had a problem';
	if (/timed? ?out|abort/i.test(message)) return 'the service took too long to answer';
	if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message))
		return 'could not reach the service';
	if (/JSON/i.test(message)) return 'the service sent an unreadable answer';
	return message;
}

/** The account as it may be shown or written anywhere: without its login. */
function shown(
	record: AccountRecord,
): Omit<AccountRecord, 'login' | 'renewedFrom' | 'inUseFrom' | 'heldBy' | 'holdUnsettled'> {
	const {
		login: _login,
		renewedFrom: _renewedFrom,
		inUseFrom: _inUseFrom,
		heldBy: _heldBy,
		holdUnsettled: _holdUnsettled,
		...rest
	} = record;
	return rest;
}

/** A reading with a reset time or a number above zero is evidence; all zeros with no clock is not. */
function hasEvidence(snapshot: UsageSnapshot): boolean {
	return snapshot.windows.some((window) => window.resetsAt !== undefined || window.percent > 0);
}

/** A new reading keeps the old reset time for a window that came without one, while that time is still ahead. */
function carryResets(
	fresh: UsageSnapshot,
	cached: UsageSnapshot | undefined,
	now: number,
): UsageSnapshot {
	if (!cached) return fresh;
	return {
		...fresh,
		windows: fresh.windows.map((window) => {
			if (window.resetsAt !== undefined) return window;
			const before = cached.windows.find((old) => old.key === window.key)?.resetsAt;
			const at = before ? Date.parse(before) : Number.NaN;
			return before !== undefined && Number.isFinite(at) && at > now
				? { ...window, resetsAt: before }
				: window;
		}),
	};
}

/** What a reading says of the limits the board does not draw. */
function othersOf(
	snapshot: UsageSnapshot,
): Pick<UsageSnapshot, 'otherLimitsInUse' | 'otherLimitsInUseUntil'> {
	if (!snapshot.otherLimitsInUse) return {};
	return {
		otherLimitsInUse: true,
		...(snapshot.otherLimitsInUseUntil
			? { otherLimitsInUseUntil: snapshot.otherLimitsInUseUntil }
			: {}),
	};
}

/** The reset list a reading carries: its own, or the last one when it brought none. */
function resetListOf(
	fresh: UsageSnapshot,
	cached: UsageSnapshot | undefined,
): Pick<
	UsageSnapshot,
	'limitResets' | 'limitResetsReadAt' | 'limitResetsIncomplete' | 'limitResetsStale'
> {
	const from = fresh.limitResets !== undefined ? fresh : cached;
	if (from?.limitResets === undefined) return {};
	return {
		limitResets: from.limitResets,
		...(from.limitResetsReadAt ? { limitResetsReadAt: from.limitResetsReadAt } : {}),
		...(from.limitResetsIncomplete ? { limitResetsIncomplete: true as const } : {}),
		...(from.limitResetsStale || from !== fresh ? { limitResetsStale: true as const } : {}),
	};
}

/**
 * A reading's resets as they stand now: one that has run out is left off, and
 * one whose limits are all empty, as the reading stands now, cannot be used.
 * What the service itself said blocks a reset is kept as it is.
 */
export function currentResets(snapshot: UsageSnapshot, now: number): LimitReset[] {
	const windows = snapshot.windows.map((window) => resetBy(window, now));
	return (snapshot.limitResets ?? [])
		.filter((reset) => {
			const at = reset.expiresAt ? Date.parse(reset.expiresAt) : Number.NaN;
			return !Number.isFinite(at) || at > now;
		})
		.map((reset) => {
			if (reset.blocked !== undefined) return reset;
			if (windows.length === 0 && snapshot.error !== undefined) {
				return { ...reset, blocked: 'its usage could not be read just now' };
			}
			if (reset.clearsUnseen) return reset;
			const othersUntil = snapshot.otherLimitsInUseUntil
				? Date.parse(snapshot.otherLimitsInUseUntil)
				: Number.NaN;
			const othersBusy =
				snapshot.otherLimitsInUse === true && (!Number.isFinite(othersUntil) || othersUntil > now);
			if (reset.clearsEvery && othersBusy) return reset;
			const cleared = reset.clearsEvery
				? windows
				: reset.windowKeys
					? windows.filter((window) => reset.windowKeys?.includes(window.key))
					: windows.filter((window) => reset.clears.includes(window.label));
			const idle =
				(cleared.length > 0 || reset.clearsEmptyUnseen === true) &&
				cleared.every((window) => window.percent <= 0);
			return idle
				? { ...reset, blocked: `no ${reset.clears.join(' or ')} usage to reset right now` }
				: reset;
		});
}

/**
 * The resets as the record of uses leaves them: while it cannot be read none
 * can be used; for a while after a use, the reset just used cannot be used
 * again, and while a use got no answer only that one can, to ask again.
 */
function afterUses(
	resets: LimitReset[],
	uses: readonly SentUse[] | null,
	now: number,
): LimitReset[] {
	if (uses === null) {
		return resets.map((reset) =>
			reset.blocked === undefined
				? { ...reset, blocked: 'the record of reset uses cannot be read' }
				: reset,
		);
	}
	// Held as the command holds them: a use still being sent, until it is
	// found; one unanswered or just used, until it can be settled.
	const recent = uses.filter((use) => use.inFlight || now < use.at + SETTLE_MS);
	const lost = recent.find((use) => use.used === undefined);
	return resets.map((reset) => {
		if (reset.blocked !== undefined) return reset;
		if (recent.some((use) => use.used && use.resetId === reset.id)) {
			return { ...reset, blocked: 'it was just used' };
		}
		if (lost && lost.resetId !== reset.id) {
			const at = new Date(Math.min(lost.at, now)).toLocaleTimeString([], {
				hour: 'numeric',
				minute: '2-digit',
			});
			return {
				...reset,
				blocked: `waiting to hear whether the ${lost.title ?? 'reset'} sent at ${at} was used`,
			};
		}
		return reset;
	});
}

/** The resets as shown: as they stand now, with those that read the same on one line counting all their uses. */
function shownResets(
	snapshot: UsageSnapshot,
	now: number,
	uses: readonly SentUse[] | null = [],
): UsageSnapshot {
	if (!snapshot.limitResets) return snapshot;
	const lines: {
		key: string;
		reset: LimitReset;
		uses: number;
		details: string[];
		ids: string[];
	}[] = [];
	for (const reset of afterUses(currentResets(snapshot, now), uses, now)) {
		const key = JSON.stringify([
			reset.title,
			reset.clears,
			reset.givesBack,
			reset.expiresAt,
			reset.blocked,
		]);
		const uses = reset.left ?? 1;
		const same = lines.find((line) => line.key === key);
		if (!same) {
			lines.push({
				key,
				reset,
				uses,
				details: reset.detail ? [reset.detail] : [],
				ids: [reset.id],
			});
			continue;
		}
		same.uses += uses;
		if (!same.ids.includes(reset.id)) same.ids.push(reset.id);
		if (reset.detail && !same.details.includes(reset.detail)) same.details.push(reset.detail);
	}
	return {
		...snapshot,
		limitResets: lines.map(({ reset, uses, details, ids }) => {
			const { left: _left, detail: _detail, ...rest } = reset;
			return {
				...rest,
				...(uses > 1 ? { left: uses } : {}),
				...(details.length > 0 ? { detail: details.join('; ') } : {}),
				...(ids.length > 1 ? { ids } : {}),
			};
		}),
	};
}

/**
 * A window whose reset has passed starts again from nothing, whatever the last
 * reading of it said, so it is shown empty until the next reading says more.
 */
function resetBy(window: UsageWindow, now: number): UsageWindow {
	const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
	if (!Number.isFinite(reset) || reset > now) return window;
	const { resetsAt: _passed, fullAt: _forecast, ...rest } = window;
	return { ...rest, percent: 0, cleared: true };
}

/** A reading whose every window has already reset says nothing about now. */
function expired(snapshot: UsageSnapshot, now: number): boolean {
	if (snapshot.windows.length === 0) return false;
	return snapshot.windows.every((window) => {
		const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
		return Number.isFinite(reset) && reset <= now;
	});
}

/**
 * Builds the board. Accounts are read in parallel because each is an
 * independent request, and a serial pass would make the wait scale with how
 * many accounts you have.
 */
export async function collectState(
	options: {
		force?: boolean;
		providers?: Record<ProviderId, Provider>;
		now?: number;
		/** When each account's read begins; the pass's own time when it is given, else the clock. */
		clock?: () => number;
		awake?: () => Promise<boolean>;
	} = {},
): Promise<State> {
	const settings = await loadSettings();
	const registry = await loadRegistry();
	const cache = await loadCache();
	const now = options.now ?? Date.now();
	const clock = options.clock ?? (options.now !== undefined ? () => now : Date.now);
	await releaseCutOff(now).catch(() => undefined);
	const sentUses = await loadSent().catch(() => null);
	const shownAccounts = new Map<string, { provider: ProviderId; state: AccountState }>();
	const marks = new Map<string, number>();
	const holds = new Map<string, number>();
	const unconfirmed = new Set<string>();
	/** What the board says of an account whose login was cleared or signed out of. */
	const signedOut = new Map<string, string>();
	const fetchedAt = new Date(now).toISOString();
	const providerSet = options.providers ?? PROVIDERS;
	const providers = {} as Record<ProviderId, ProviderState>;

	const touched = new Set<string>();
	let awakeNow: Promise<boolean> | undefined;
	const awake = (): Promise<boolean> => {
		awakeNow ??= (options.awake ?? fullyAwake)();
		return awakeNow;
	};

	for (const id of Object.keys(providerSet) as ProviderId[]) {
		const provider = providerSet[id];
		const records = accountsFor(registry, id);
		let installed: Credential | null = null;
		let unreadable = false;
		try {
			installed = await provider.readAgentCredential();
		} catch {
			unreadable = true;
		}
		// A login the agent cleared, or one signed out of, holds nothing to read
		// with or to name. One the agent cleared because the service would no
		// longer renew it is replaced with its account's saved login.
		const out = installed ? provider.signedOut?.(installed) : undefined;
		if (installed && out) {
			const owner = ownerOfCleared(provider, records, installed, registry.active[id]);
			const canReplace = out.ended && owner !== undefined;
			const waking = canReplace && !(await awake());
			const back =
				canReplace && !waking
					? await replaceEnded(provider, owner, installed, now).catch(() => null)
					: null;
			if (back && !provider.signedOut?.(back)) {
				installed = back;
			} else {
				installed = null;
				const noteFor = owner ?? records.find((record) => record.id === registry.active[id]);
				if (noteFor) signedOut.set(noteFor.id, signedOutNote(provider, out, waking));
			}
		}
		let liveAwaitsRenewal: string | undefined;
		if (installed) {
			// On an idle machine nobody refreshes the installed login, so it
			// expires and reads as refused. With an agent running, that agent
			// renews it on its next turn; otherwise hotseat does, once the Mac
			// is fully awake.
			const expired = (credential: Credential): boolean => {
				const expires = provider.expiresAt?.(credential);
				return expires !== undefined && expires <= now;
			};
			if (expired(installed)) {
				const running = await provider.runningProcesses().catch(() => null);
				if (running === null) {
					liveAwaitsRenewal =
						'the login in use has expired; could not tell whether an agent is using it, so it is left for now';
				} else if (running.length > 0) {
					liveAwaitsRenewal =
						'the login in use has expired; the running agent will refresh it on its next turn';
				} else if (!(await awake())) {
					liveAwaitsRenewal = WAITING_FOR_WAKE;
				} else {
					// Renewed only once it is known whose login this is.
					const who = await liveIdentity(provider, installed, registry, cache);
					const owner = who
						? records.find((record) => record.email.toLowerCase() === who.email.toLowerCase())
						: undefined;
					if (owner) {
						const renewed = await renewInstalled(provider, owner, installed, expired).catch(
							() => null,
						);
						if (renewed) installed = renewed;
					} else {
						liveAwaitsRenewal =
							'the login in use has expired and is not one of the saved accounts; its agent will refresh it';
					}
				}
			}
		}
		let live: { credential: Credential; email: string; accountId?: string } | null = null;
		// A login is installed but nobody can say whose: the account hotseat last
		// put in use almost certainly still holds it, so it is neither read nor
		// refreshed from its saved copy, whose refresh token the agent may have
		// already used up. It keeps its last numbers until it can be confirmed.
		let unconfirmedId: string | undefined;
		if (installed) {
			const identity = await liveIdentity(provider, installed, registry, cache);
			if (identity) {
				live = {
					credential: installed,
					email: identity.email,
					...(identity.accountId ? { accountId: identity.accountId } : {}),
				};
				// The agent replaces its refresh token as it works. Keeping the saved
				// copy current means it is never the stale one when it is needed.
				const owner = records.find(
					(record) => record.email.toLowerCase() === identity.email.toLowerCase(),
				);
				if (owner) await adoptIfNewer(provider, owner, installed).catch(() => false);
			} else {
				unconfirmedId = records.find((record) => record.id === registry.active[id])?.id;
			}
		} else if (unreadable) {
			unconfirmedId = records.find((record) => record.id === registry.active[id])?.id;
		}

		const accounts = await Promise.all(
			records.map(async (record): Promise<AccountState> => {
				const cached = cache.entries[record.id];
				const uses = sentUses?.[sentKey(id, record)];
				// A use answered or lost is kept with the account; one still being
				// sent only holds its numbers back while it is.
				const durable = Math.max(cached?.resetAtMs ?? 0, usedAt(uses, false));
				if (durable > 0) marks.set(record.id, durable);
				const mark = Math.max(durable, usedAt(uses));
				if (mark > 0) holds.set(record.id, mark);
				const setAside = cached !== undefined && beforeReset(cached, mark);
				const good = cached !== undefined && cached.snapshot.windows.length > 0 && !setAside;
				const lastShown = cached ? shownOf(cached, mark) : undefined;
				const isActive = live !== null && record.email.toLowerCase() === live.email.toLowerCase();
				const usedPercent =
					lastShown && lastShown.windows.length > 0
						? Math.max(...lastShown.windows.map((window) => window.percent))
						: undefined;
				const age = cached ? now - cached.attemptedAtMs : Number.POSITIVE_INFINITY;
				const due = options.force
					? REREAD_FLOOR_MS
					: cadenceFor({
							isActive,
							usedPercent,
							previousPercent: cached?.previousPercent,
							thresholdPercent: settings.autoThresholdPercent,
						});
				if (record.id === unconfirmedId) {
					unconfirmed.add(record.id);
					return {
						...shown(record),
						usage: unconfirmedOf(lastShown ?? { fetchedAt, windows: [] }),
					};
				}
				const asked = cached !== undefined && (cached.readSoonAt ?? 0) > cached.attemptedAtMs;
				if (cached && lastShown && age < due && !asked)
					return { ...shown(record), usage: lastShown };
				const retryAt = cached?.snapshot.retryAt ? Date.parse(cached.snapshot.retryAt) : Number.NaN;
				if (cached && lastShown && Number.isFinite(retryAt) && retryAt > now)
					return { ...shown(record), usage: lastShown };

				if (isActive && liveAwaitsRenewal) {
					// Nothing to read with: the token has expired and will be
					// renewed soon. Neither a failure nor a reason to move.
					const snapshot: UsageSnapshot = {
						...(good ? cached.snapshot : { fetchedAt, windows: [] }),
						error: liveAwaitsRenewal,
						errorKind: 'other',
					};
					cache.entries[record.id] = {
						snapshot,
						fetchedAtMs: cached?.fetchedAtMs ?? 0,
						attemptedAtMs: clock(),
						...(cached?.previousPercent !== undefined
							? { previousPercent: cached.previousPercent }
							: {}),
					};
					touched.add(record.id);
					return { ...shown(record), usage: snapshot };
				}

				const readAt = clock();
				const attempt = await readUsage(
					provider,
					record,
					live,
					now,
					cached?.deadLogin,
					awake,
					// Asked to read again, the list of resets is listed again, until a list read after the asking.
					cached && (cached.readSoonAt ?? 0) > listAt(cached)
						? listToRenew(cached.snapshot)
						: cached?.snapshot,
				);
				touched.add(record.id);
				const usage = attempt.usage;
				if (usage.windows.length === 0 && usage.note !== undefined && !attempt.failure) {
					// The service answered and has no limit to report: a good read
					// with nothing to draw, not a failed one.
					cache.entries[record.id] = {
						snapshot: usage,
						fetchedAtMs: readAt,
						attemptedAtMs: readAt,
					};
					return { ...shown(record), usage };
				}
				if (usage.windows.length > 0 && !attempt.failure) {
					if (
						good &&
						!hasEvidence(usage) &&
						hasEvidence(cached.snapshot) &&
						!expired(cached.snapshot, now)
					) {
						// All zeros with no clock is what the service sends when it
						// has nothing to say. It does not replace numbers that said something.
						const {
							otherLimitsInUse: _before,
							otherLimitsInUseUntil: _beforeUntil,
							limitResets: _list,
							limitResetsReadAt: _listReadAt,
							limitResetsIncomplete: _listIncomplete,
							limitResetsStale: _listStale,
							...base
						} = cached.snapshot;
						const kept: UsageSnapshot = {
							...withoutOutcome(base),
							...resetListOf(usage, cached.snapshot),
							...othersOf(usage),
						};
						const { deadLogin: _dead, ...answered } = cached;
						cache.entries[record.id] = { ...answered, snapshot: kept, attemptedAtMs: readAt };
						return { ...shown(record), usage: kept };
					}
					const snapshot = {
						...usage,
						...resetListOf(usage, cached?.snapshot),
					};
					cache.entries[record.id] = {
						snapshot,
						fetchedAtMs: readAt,
						attemptedAtMs: readAt,
						...(usedPercent !== undefined ? { previousPercent: usedPercent } : {}),
					};
					return { ...shown(record), usage: snapshot };
				}
				// A failed read replaces no numbers: usage only climbs within a
				// window, so the last good reading stays a valid floor until that
				// window resets. The failure is still shown, and an auth failure
				// counted; a busy or unreachable service says nothing about the login.
				const kind = attempt.failure?.kind ?? 'other';
				const failedReads = kind === 'auth' ? (cached?.snapshot.failedReads ?? 0) + 1 : undefined;
				const keep = good && !expired(cached.snapshot, now);
				const wait =
					kind === 'throttled'
						? new Date(
								clock() + (attempt.failure?.retryAfterMs ?? THROTTLE_BACKOFF_MS),
							).toISOString()
						: undefined;
				const snapshot: UsageSnapshot = {
					...(keep ? cached.snapshot : usage),
					...resetListOf(usage, cached?.snapshot),
					error: usage.error ?? 'could not read usage',
					errorKind: kind,
					...(failedReads !== undefined ? { failedReads } : {}),
					...(wait ? { retryAt: wait } : {}),
				};
				if (failedReads === undefined) delete snapshot.failedReads;
				if (!wait) delete snapshot.retryAt;
				cache.entries[record.id] = {
					snapshot,
					fetchedAtMs: cached?.fetchedAtMs ?? 0,
					attemptedAtMs: readAt,
					...(cached?.previousPercent !== undefined
						? { previousPercent: cached.previousPercent }
						: {}),
					...(attempt.failure?.deadLogin ? { deadLogin: attempt.failure.deadLogin } : {}),
				};
				return { ...shown(record), usage: snapshot };
			}),
		);

		for (const account of accounts) {
			const note = signedOut.get(account.id);
			if (note) account.usage = noted(account.usage ?? { fetchedAt, windows: [] }, note);
		}
		const active = live
			? accounts.find((account) => account.email.toLowerCase() === live?.email.toLowerCase())
			: accounts.find((account) => account.id === unconfirmedId);
		// The agent's own reading of the account in use, when it is newer than
		// ours: what its banner shows, at no request. The model limits it does
		// not report stay from the last full reading.
		const local = active && live ? await provider.localReading?.().catch(() => null) : null;
		const entry = active ? cache.entries[active.id] : undefined;
		if (
			active &&
			local &&
			entry &&
			local.fetchedAtMs > Math.max(entry.fetchedAtMs, entry.local?.fetchedAtMs ?? 0) &&
			(local.accountId === undefined || local.accountId === live?.accountId)
		) {
			const before = shownOf(entry, holds.get(active.id) ?? 0).windows;
			cache.entries[active.id] = {
				...entry,
				local: { fetchedAtMs: local.fetchedAtMs, windows: local.windows },
				...(before.length > 0
					? { previousPercent: Math.max(...before.map((window) => window.percent)) }
					: {}),
			};
			touched.add(active.id);
			active.usage = shownOf(cache.entries[active.id] as CacheEntry, holds.get(active.id) ?? 0);
		}
		for (const account of accounts) {
			if (account.usage)
				account.usage = {
					...account.usage,
					windows: account.usage.windows.map((window) => resetBy(window, now)),
				};
		}
		providers[id] = { accounts, ...(active ? { activeAccountId: active.id } : {}) };
		for (const account of accounts) shownAccounts.set(account.id, { provider: id, state: account });
	}

	// Written under a lock, over whatever another pass wrote meanwhile: two
	// collectors may run at once, and each keeps only the accounts it read,
	// unless another pass has already written a later attempt, or the same
	// attempt with a later reading, such as the agent's own. Entries for accounts that no longer exist are dropped, so the
	// file cannot grow without bound as accounts come and go.
	let rowsFrom: SentUses | null = null;
	const lock = await acquireLock(hotseatHome(), 10_000, 'usage.lock');
	try {
		const latest = await loadCache();
		// The record of uses as it stands now, not as it stood when this pass
		// began: a use made meanwhile holds back what this pass read before it.
		const usesNow = await loadSent().catch(() => null);
		const usesOf = (id: string): readonly SentUse[] => {
			const account = shownAccounts.get(id);
			return usesNow === null || !account
				? []
				: (usesNow[sentKey(account.provider, account.state)] ?? []);
		};
		const durableOf = (id: string) => Math.max(marks.get(id) ?? 0, usedAt(usesOf(id), false));
		const holdOf = (id: string, entry: CacheEntry | undefined) =>
			Math.max(
				entry?.resetAtMs ?? 0,
				durableOf(id),
				usesNow === null ? (holds.get(id) ?? 0) : usedAt(usesOf(id)),
			);
		for (const id of touched) {
			const entry = cache.entries[id];
			if (!entry) continue;
			const there = latest.entries[id];
			const hold = holdOf(id, there);
			const eligible = entry.fetchedAtMs >= hold;
			const after = there !== undefined && !beforeReset(there, hold);
			// All zeros with no clock is what the service sends when it has
			// nothing to say: it does not replace numbers that said something.
			const saysNothing =
				after &&
				eligible &&
				entry.fetchedAtMs > there.fetchedAtMs &&
				entry.snapshot.windows.length > 0 &&
				!hasEvidence(entry.snapshot) &&
				hasEvidence(there.snapshot) &&
				!expired(there.snapshot, entry.fetchedAtMs);
			// A limit read without its reset time keeps the one a reading from
			// after the same reset gave, while that time was still ahead when read.
			const timed =
				after && eligible && !saysNothing
					? { ...entry, snapshot: carryResets(entry.snapshot, there.snapshot, entry.fetchedAtMs) }
					: entry;
			latest.entries[id] = there
				? merged(there, timed, eligible && !saysNothing, listAt(entry) >= hold)
				: timed;
		}
		// A use answered or lost is copied into the account's entry.
		for (const id of shownAccounts.keys()) {
			const stored = latest.entries[id];
			const mark = durableOf(id);
			if (stored && mark > (stored.resetAtMs ?? 0))
				latest.entries[id] = { ...stored, resetAtMs: mark };
		}
		// What this pass returns is what is now stored, which holds its own
		// readings and any newer ones, shown as nothing while a use since
		// holds it back. A login that could not be confirmed is said as such.
		for (const [id, account] of shownAccounts) {
			const stored = latest.entries[id];
			if (!stored) continue;
			const usage = presented(stored, now, holdOf(id, stored));
			const note = unconfirmed.has(id) ? UNCONFIRMED : signedOut.get(id);
			account.state.usage = note ? noted(usage, note) : usage;
		}
		rowsFrom = usesNow;
		latest.identities = { ...latest.identities, ...cache.identities };
		const known = new Set(registry.accounts.map((account) => account.id));
		for (const id of Object.keys(latest.entries)) {
			if (!known.has(id)) delete latest.entries[id];
		}
		await writeJsonAtomic(usageCachePath(), latest, 0o600);
	} finally {
		await lock.release();
	}
	// The rows of resets are drawn last, from the record of uses as read
	// under the lock.
	for (const { provider, state } of shownAccounts.values()) {
		if (state.usage) {
			state.usage = shownResets(
				state.usage,
				now,
				rowsFrom === null ? null : (rowsFrom[sentKey(provider, state)] ?? []),
			);
		}
	}
	return { version: 1, updatedAt: fetchedAt, providers };
}
