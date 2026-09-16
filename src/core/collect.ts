import { ClaudeProvider } from '../providers/claude/index.ts';
import { CodexProvider } from '../providers/codex/index.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { usageCachePath } from './paths.ts';
import { accountsFor, loadRegistry } from './registry.ts';
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
}

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
	const stored = await readJson<Partial<UsageCache>>(usageCachePath());
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
): Promise<UsageSnapshot> {
	try {
		// The installed credential is the freshest copy for whichever account
		// holds it, because the agent may have rotated its token since it was saved.
		if (live && live.email.toLowerCase() === account.email.toLowerCase()) {
			return await provider.fetchUsage(live.credential);
		}
		const stored = await loadCredential(account);
		if (!stored) return { fetchedAt, windows: [], error: 'no saved login' };
		const refreshed = await provider.refreshIfNeeded(stored);
		if (refreshed !== stored) await storeCredential(account, refreshed);
		return await provider.fetchUsage(refreshed);
	} catch (error) {
		return { fetchedAt, windows: [], error: plainError(error) };
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

	for (const id of Object.keys(providerSet) as ProviderId[]) {
		const provider = providerSet[id];
		const records = accountsFor(registry, id);
		const installed = await provider.readAgentCredential().catch(() => null);
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

				const usage = await readUsage(provider, record, live, fetchedAt);
				if (usage.windows.length > 0) {
					cache.entries[record.id] = {
						snapshot: usage,
						fetchedAtMs: now,
						attemptedAtMs: now,
						...(usedPercent !== undefined ? { previousPercent: usedPercent } : {}),
					};
					return { ...shown(record), usage };
				}
				// A failed read replaces no numbers: usage only climbs within a
				// window, so the last good reading stays a valid floor until that
				// window resets. The failure is still shown, and counted.
				const failedReads = (cached?.snapshot.failedReads ?? 0) + 1;
				const keep = good && !expired(cached.snapshot, now);
				const snapshot: UsageSnapshot = keep
					? { ...cached.snapshot, error: usage.error ?? 'could not read usage', failedReads }
					: { ...usage, failedReads };
				cache.entries[record.id] = {
					snapshot,
					fetchedAtMs: keep ? cached.fetchedAtMs : now,
					attemptedAtMs: now,
					...(cached?.previousPercent !== undefined
						? { previousPercent: cached.previousPercent }
						: {}),
				};
				return { ...shown(record), usage: snapshot };
			}),
		);

		const active = live
			? accounts.find((account) => account.email.toLowerCase() === live?.email.toLowerCase())
			: undefined;
		providers[id] = { accounts, ...(active ? { activeAccountId: active.id } : {}) };
	}

	// Drop cache entries for accounts that no longer exist, so the file cannot
	// grow without bound as accounts come and go.
	const known = new Set(registry.accounts.map((account) => account.id));
	for (const id of Object.keys(cache.entries)) {
		if (!known.has(id)) delete cache.entries[id];
	}
	await writeJsonAtomic(usageCachePath(), cache, 0o600);
	return { version: 1, updatedAt: fetchedAt, providers };
}
