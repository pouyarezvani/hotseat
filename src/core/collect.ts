import { ClaudeProvider } from '../providers/claude/index.ts';
import { CodexProvider } from '../providers/codex/index.ts';
import { classify, ServiceError } from './errors.ts';
import { acquireLock, readJsonLoose, writeJsonAtomic } from './fs.ts';
import { hotseatHome, usageCachePath } from './paths.ts';
import { accountsFor, loadRegistry } from './registry.ts';
import { sessionLogin, sessionRunning } from './session.ts';
import { loadSettings } from './settings.ts';
import type {
	AccountRecord,
	AccountState,
	Credential,
	Identity,
	Provider,
	ProviderId,
	ProviderState,
	Registry,
	State,
	UsageSnapshot,
} from './types.ts';
import { loadCredential, storeCredential } from './vault.ts';

export const PROVIDERS: Record<ProviderId, Provider> = {
	claude: new ClaudeProvider(),
	codex: new CodexProvider(),
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
}

/** How long to wait after being told to slow down, when the service does not say. */
export const THROTTLE_BACKOFF_MS = 10 * 60_000;

interface LiveIdentity {
	fingerprint: string;
	email: string;
	plan?: string;
}

interface UsageCache {
	version: 2;
	entries: Record<string, CacheEntry>;
	/** Which account the installed login belongs to, keyed by service. */
	identities: Partial<Record<ProviderId, LiveIdentity>>;
}

async function loadCache(): Promise<UsageCache> {
	const stored = await readJsonLoose<Partial<UsageCache>>(usageCachePath());
	if (stored?.version !== 2) return { version: 2, entries: {}, identities: {} };
	return { version: 2, entries: stored.entries ?? {}, identities: stored.identities ?? {} };
}

/**
 * Whatever changes when a login is replaced or its token rotated. The whole
 * credential is hashed rather than one field so no service-specific shape has
 * to be known here.
 */
export function fingerprint(credential: Credential): string {
	return new Bun.CryptoHasher('sha256').update(JSON.stringify(credential)).digest('hex');
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
	if (remembered && remembered.fingerprint === print) {
		return { email: remembered.email, ...(remembered.plan ? { plan: remembered.plan } : {}) };
	}
	const asked = await provider.identify(installed).catch(() => undefined);
	if (asked) {
		if (cache) {
			cache.identities[provider.id] = {
				fingerprint: print,
				email: asked.email,
				...(asked.plan ? { plan: asked.plan } : {}),
			};
		}
		return asked;
	}
	const lastInstalled = registry.accounts.find(
		(account) => account.id === registry.active[provider.id],
	);
	if (!lastInstalled) return undefined;
	const saved = await loadCredential(lastInstalled).catch(() => null);
	if (!saved || fingerprint(saved) !== print) return undefined;
	return {
		email: lastInstalled.email,
		...(lastInstalled.plan ? { plan: lastInstalled.plan } : {}),
	};
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
	fetchedAt: string,
	deadLogin: string | undefined,
): Promise<Attempt> {
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
			return { usage: await provider.fetchUsage(live.credential) };
		}
		// An account open in another terminal is read with that terminal's own
		// login, and never refreshed from here: the running agent owns that
		// token now, and a refresh from a stale copy would log it out.
		if (await sessionRunning(provider, account)) {
			const owned = await sessionLogin(provider, account);
			if (owned) return { usage: await provider.fetchUsage(owned) };
		}
		const stored = await loadCredential(account);
		if (!stored) return { usage: { fetchedAt, windows: [], error: 'no saved login' } };
		if (deadLogin !== undefined && deadLogin === fingerprint(stored)) {
			return {
				usage: {
					fetchedAt,
					windows: [],
					error: 'the saved login no longer works - run hotseat add to sign in again',
				},
				failure: { kind: 'auth', deadLogin },
			};
		}
		let refreshed: Credential;
		try {
			refreshed = await provider.refreshIfNeeded(stored);
		} catch (error) {
			if (classify(error) === 'auth') {
				return failed(
					new ServiceError(
						'the saved login no longer works - run hotseat add to sign in again',
						401,
					),
					fingerprint(stored),
				);
			}
			return failed(error);
		}
		if (refreshed !== stored) await storeCredential(account, refreshed);
		return { usage: await provider.fetchUsage(refreshed) };
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
function shown(record: AccountRecord): Omit<AccountRecord, 'login'> {
	const { login: _login, ...rest } = record;
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
	options: { force?: boolean; providers?: Record<ProviderId, Provider>; now?: number } = {},
): Promise<State> {
	const settings = await loadSettings();
	const registry = await loadRegistry();
	const cache = await loadCache();
	const now = options.now ?? Date.now();
	const fetchedAt = new Date(now).toISOString();
	const providerSet = options.providers ?? PROVIDERS;
	const providers = {} as Record<ProviderId, ProviderState>;

	const touched = new Set<string>();

	for (const id of Object.keys(providerSet) as ProviderId[]) {
		const provider = providerSet[id];
		const records = accountsFor(registry, id);
		let installed = await provider.readAgentCredential().catch(() => null);
		let liveWaitsForAgent = false;
		if (installed) {
			// On an idle machine nobody refreshes the installed login, so it
			// expires and reads as refused. With no agent running, hotseat
			// refreshes it; with one running, that agent will on its next turn.
			const expires = provider.expiresAt?.(installed);
			if (expires !== undefined && expires <= now) {
				const running = await provider.runningProcesses().catch(() => []);
				if (running.length === 0) {
					const refreshed = await provider.refreshIfNeeded(installed).catch(() => null);
					if (refreshed && refreshed !== installed) {
						await provider.writeAgentCredential(refreshed).catch(() => undefined);
						installed = refreshed;
						const who = await provider.identify(refreshed).catch(() => undefined);
						const owner = who
							? records.find((record) => record.email.toLowerCase() === who.email.toLowerCase())
							: undefined;
						if (owner) await storeCredential(owner, refreshed);
					}
				} else {
					liveWaitsForAgent = true;
				}
			}
		}
		let live: { credential: Credential; email: string } | null = null;
		if (installed) {
			const identity = await liveIdentity(provider, installed, registry, cache);
			if (identity) live = { credential: installed, email: identity.email };
		}

		const accounts = await Promise.all(
			records.map(async (record): Promise<AccountState> => {
				const cached = cache.entries[record.id];
				const good = cached !== undefined && cached.snapshot.windows.length > 0;
				const isActive = live !== null && record.email.toLowerCase() === live.email.toLowerCase();
				const usedPercent = good
					? Math.max(...cached.snapshot.windows.map((window) => window.percent))
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
				if (cached && age < due) return { ...shown(record), usage: cached.snapshot };
				const retryAt = cached?.snapshot.retryAt ? Date.parse(cached.snapshot.retryAt) : Number.NaN;
				if (cached && Number.isFinite(retryAt) && retryAt > now)
					return { ...shown(record), usage: cached.snapshot };

				if (isActive && liveWaitsForAgent) {
					// Nothing to read with: the token has expired and its owner
					// is about to renew it. Neither a failure nor a reason to move.
					const snapshot: UsageSnapshot = {
						...(good ? cached.snapshot : { fetchedAt, windows: [] }),
						error:
							'the login in use has expired; the running agent will refresh it on its next turn',
						errorKind: 'other',
					};
					cache.entries[record.id] = {
						snapshot,
						fetchedAtMs: good ? cached.fetchedAtMs : now,
						attemptedAtMs: now,
						...(cached?.previousPercent !== undefined
							? { previousPercent: cached.previousPercent }
							: {}),
					};
					touched.add(record.id);
					return { ...shown(record), usage: snapshot };
				}

				const attempt = await readUsage(provider, record, live, fetchedAt, cached?.deadLogin);
				touched.add(record.id);
				const usage = attempt.usage;
				if (usage.windows.length > 0 && !attempt.failure) {
					if (good && !hasEvidence(usage) && hasEvidence(cached.snapshot)) {
						// All zeros with no clock is what the service sends when it
						// has nothing to say. It does not replace numbers that said something.
						cache.entries[record.id] = { ...cached, attemptedAtMs: now };
						return { ...shown(record), usage: cached.snapshot };
					}
					const snapshot = carryResets(usage, good ? cached.snapshot : undefined, now);
					cache.entries[record.id] = {
						snapshot,
						fetchedAtMs: now,
						attemptedAtMs: now,
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
						? new Date(now + (attempt.failure?.retryAfterMs ?? THROTTLE_BACKOFF_MS)).toISOString()
						: undefined;
				const snapshot: UsageSnapshot = {
					...(keep ? cached.snapshot : usage),
					error: usage.error ?? 'could not read usage',
					errorKind: kind,
					...(failedReads !== undefined ? { failedReads } : {}),
					...(wait ? { retryAt: wait } : {}),
				};
				if (failedReads === undefined) delete snapshot.failedReads;
				if (!wait) delete snapshot.retryAt;
				cache.entries[record.id] = {
					snapshot,
					fetchedAtMs: keep ? cached.fetchedAtMs : now,
					attemptedAtMs: now,
					...(cached?.previousPercent !== undefined
						? { previousPercent: cached.previousPercent }
						: {}),
					...(attempt.failure?.deadLogin ? { deadLogin: attempt.failure.deadLogin } : {}),
				};
				return { ...shown(record), usage: snapshot };
			}),
		);

		const active = live
			? accounts.find((account) => account.email.toLowerCase() === live?.email.toLowerCase())
			: undefined;
		providers[id] = { accounts, ...(active ? { activeAccountId: active.id } : {}) };
	}

	// Written under a lock, over whatever another pass wrote meanwhile: two
	// collectors may run at once, and each keeps only the accounts it read.
	// Entries for accounts that no longer exist are dropped, so the file cannot
	// grow without bound as accounts come and go.
	const lock = await acquireLock(hotseatHome(), 10_000, 'usage.lock');
	try {
		const latest = await loadCache();
		for (const id of touched) {
			const entry = cache.entries[id];
			if (entry) latest.entries[id] = entry;
		}
		latest.identities = { ...latest.identities, ...cache.identities };
		const known = new Set(registry.accounts.map((account) => account.id));
		for (const id of Object.keys(latest.entries)) {
			if (!known.has(id)) delete latest.entries[id];
		}
		await writeJsonAtomic(usageCachePath(), latest, 0o600);
	} finally {
		await lock.release();
	}
	return { version: 1, updatedAt: fetchedAt, providers };
}
