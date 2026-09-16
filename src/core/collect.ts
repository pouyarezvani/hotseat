import { ClaudeProvider } from '../providers/claude/index.ts';
import { CodexProvider } from '../providers/codex/index.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { usageCachePath } from './paths.ts';
import { accountsFor, loadRegistry } from './registry.ts';
import { loadSettings } from './settings.ts';
import type {
	AccountRecord,
	AccountState,
	Provider,
	ProviderId,
	ProviderState,
	State,
	UsageSnapshot,
} from './types.ts';
import { loadCredential, storeCredential } from './vault.ts';

export const PROVIDERS: Record<ProviderId, Provider> = {
	claude: new ClaudeProvider(),
	codex: new CodexProvider(),
};

/** Even an explicit refresh will not re-read an account faster than this. */
export const MIN_REREAD_MS = 60_000;

interface UsageCache {
	version: 1;
	entries: Record<string, { snapshot: UsageSnapshot; fetchedAtMs: number }>;
}

async function loadCache(): Promise<UsageCache> {
	return (await readJson<UsageCache>(usageCachePath())) ?? { version: 1, entries: {} };
}

/**
 * Reads one account's usage using its own saved login. Every account is polled,
 * not just the one in use: an account with no reading cannot be compared, so
 * switching would be choosing blind.
 */
async function readUsage(
	provider: Provider,
	account: AccountRecord,
	live: { credential: Record<string, unknown>; email: string } | null,
): Promise<UsageSnapshot> {
	const fetchedAt = new Date().toISOString();
	// The installed credential is the freshest copy for whichever account holds
	// it, because the agent may have rotated its token since it was saved.
	if (live && live.email === account.email) return provider.fetchUsage(live.credential);

	const stored = await loadCredential(account);
	if (!stored) return { fetchedAt, windows: [], error: 'no saved login' };
	try {
		const refreshed = await provider.refreshIfNeeded(stored);
		if (refreshed !== stored) await storeCredential(account, refreshed);
		return await provider.fetchUsage(refreshed);
	} catch (error) {
		return { fetchedAt, windows: [], error: (error as Error).message };
	}
}

/**
 * Builds the board. Accounts are read in parallel because each is an
 * independent request, and a serial pass would make the wait scale with how
 * many accounts you have.
 */
export async function collectState(options: { force?: boolean } = {}): Promise<State> {
	const settings = await loadSettings();
	const registry = await loadRegistry();
	const cache = await loadCache();
	const now = Date.now();
	const ttl = settings.refreshIntervalSeconds * 1000;
	const providers = {} as Record<ProviderId, ProviderState>;

	for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
		const provider = PROVIDERS[id];
		const records = accountsFor(registry, id);
		const installed = await provider.readAgentCredential().catch(() => null);
		let live: { credential: Record<string, unknown>; email: string } | null = null;
		if (installed) {
			const email = await provider
				.identify(installed)
				.then((identity) => identity.email)
				.catch(() => undefined);
			if (email) live = { credential: installed, email };
		}

		const accounts = await Promise.all(
			records.map(async (record): Promise<AccountState> => {
				const cached = cache.entries[record.id];
				const good = cached && cached.snapshot.windows.length > 0;
				// A forced read still respects a short floor. Usage barely moves in a
				// minute, and reading faster than that is what trips the rate limit.
				const age = cached ? now - cached.fetchedAtMs : Number.POSITIVE_INFINITY;
				const floor = options.force ? MIN_REREAD_MS : ttl;
				if (good && cached && age < floor) return { ...record, usage: cached.snapshot };

				const usage = await readUsage(provider, record, live);
				// A failed read replaces nothing. Usage only climbs within a window, so
				// the last good reading stays a valid floor until that window resets.
				if (usage.windows.length === 0 && good && cached) {
					cache.entries[record.id] = { snapshot: cached.snapshot, fetchedAtMs: now };
					return { ...record, usage: cached.snapshot };
				}
				cache.entries[record.id] = { snapshot: usage, fetchedAtMs: now };
				return { ...record, usage };
			}),
		);

		const active = live ? accounts.find((account) => account.email === live?.email) : undefined;
		providers[id] = { accounts, ...(active ? { activeAccountId: active.id } : {}) };
	}

	// Drop cache entries for accounts that no longer exist, so the file cannot
	// grow without bound as accounts come and go.
	const known = new Set(registry.accounts.map((account) => account.id));
	for (const id of Object.keys(cache.entries)) {
		if (!known.has(id)) delete cache.entries[id];
	}
	await writeJsonAtomic(usageCachePath(), cache, 0o600);
	return { version: 1, updatedAt: new Date(now).toISOString(), providers };
}
