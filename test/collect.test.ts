import { describe, expect, test } from 'bun:test';
import { ACTIVE_CALM_MS, CANDIDATE_MS, collectState, plainError } from '../src/core/collect.ts';
import { updateRegistry, upsertAccount } from '../src/core/registry.ts';
import type { AccountRecord, UsageSnapshot } from '../src/core/types.ts';
import { storeCredential } from '../src/core/vault.ts';
import { cred, type FakeProvider, fakeProviders } from './fake-provider.ts';
import { withHome } from './helpers.ts';

const T = Date.parse('2026-09-16T12:00:00Z');
const MIN = 60_000;

function reading(
	percent: number,
	resetsAt = new Date(T + 5 * 3_600_000).toISOString(),
): UsageSnapshot {
	return {
		fetchedAt: new Date(T).toISOString(),
		windows: [
			{ key: 'five_hour', label: '5h', percent, resetsAt },
			{ key: 'seven_day', label: 'week', percent: percent / 2, resetsAt },
		],
	};
}

interface World {
	providers: { claude: FakeProvider; codex: FakeProvider };
	a: AccountRecord;
	b: AccountRecord;
}

/** Two Claude accounts, A installed and in use, both readable. */
async function world(): Promise<World> {
	const providers = fakeProviders();
	const claude = providers.claude;
	const a = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
	);
	const b = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
	);
	await updateRegistry((registry) => {
		registry.active.claude = a.id;
	});
	await storeCredential(a, cred('A'));
	await storeCredential(b, cred('B'));
	claude.identities.set('A', { email: 'a@example.com', plan: 'max' });
	claude.identities.set('B', { email: 'b@example.com' });
	claude.readings.set('A', () => reading(50));
	claude.readings.set('B', () => reading(10));
	claude.installed = cred('A');
	return { providers, a, b };
}

describe('reading every account', () => {
	test('one account that cannot be read leaves the others readable', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.readings.delete('B');
			const state = await collectState({ providers, now: T });
			const byId = new Map(state.providers.claude.accounts.map((account) => [account.id, account]));
			expect(byId.get(a.id)?.usage?.windows.length).toBe(2);
			expect(byId.get(b.id)?.usage?.windows).toEqual([]);
			expect(byId.get(b.id)?.usage?.error).toBe('the saved login no longer works');
			expect(state.providers.claude.activeAccountId).toBe(a.id);
		});
	});

	test('a failed read keeps the last good numbers, marked, with their own time', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await collectState({ providers, now: T });
			providers.claude.readings.set('B', () => {
				throw new Error('usage request failed with 429');
			});
			const later = T + CANDIDATE_MS + MIN;
			const state = await collectState({ providers, now: later });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.windows.map((window) => window.percent)).toEqual([10, 5]);
			expect(usage?.error).toBe('read too often, waiting a while');
			expect(usage?.failedReads).toBe(1);
			expect(usage?.fetchedAt).toBe(new Date(T).toISOString());
		});
	});

	test('a failed read is not tried again before its turn', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await collectState({ providers, now: T });
			providers.claude.readings.delete('B');
			const later = T + CANDIDATE_MS + MIN;
			await collectState({ providers, now: later });
			const reads = providers.claude.calls.fetchUsage;
			await collectState({ providers, now: later + 10_000 });
			await collectState({ providers, now: later + 20_000 });
			expect(providers.claude.calls.fetchUsage).toBe(reads);
		});
	});

	test('an account with no reading at all is still read on its own cadence, not every time', async () => {
		await withHome(async () => {
			const { providers } = await world();
			providers.claude.readings.delete('B');
			await collectState({ providers, now: T });
			const reads = providers.claude.calls.fetchUsage;
			await collectState({ providers, now: T + 10_000 });
			expect(providers.claude.calls.fetchUsage).toBe(reads);
			// Both fall due by then: the account in use on its three minutes, the
			// unreadable one on its five.
			await collectState({ providers, now: T + CANDIDATE_MS + 1 });
			expect(providers.claude.calls.fetchUsage).toBe(reads + 2);
		});
	});

	test('failed reads are counted in a row and forgotten on the next good one', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			await collectState({ providers, now: T });
			providers.claude.readings.delete('A');
			const step = ACTIVE_CALM_MS + 1;
			await collectState({ providers, now: T + step });
			const second = await collectState({ providers, now: T + 2 * step });
			const failing = second.providers.claude.accounts.find((account) => account.id === a.id);
			expect(failing?.usage?.failedReads).toBe(2);
			providers.claude.readings.set('A', () => reading(55));
			const third = await collectState({ providers, now: T + 3 * step });
			const healthy = third.providers.claude.accounts.find((account) => account.id === a.id);
			expect(healthy?.usage?.failedReads).toBeUndefined();
			expect(healthy?.usage?.error).toBeUndefined();
			expect(healthy?.usage?.windows[0]?.percent).toBe(55);
		});
	});

	test('numbers from before a reset are dropped when the read that would replace them fails', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.readings.set('B', () => reading(80, new Date(T + 3_600_000).toISOString()));
			await collectState({ providers, now: T });
			providers.claude.readings.delete('B');
			const state = await collectState({ providers, now: T + 2 * 3_600_000 });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.windows).toEqual([]);
			expect(usage?.error).toBeDefined();
		});
	});

	test('whose login is installed is asked once per credential, not once per read', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await collectState({ providers, now: T });
			await collectState({ providers, now: T + 1 });
			await collectState({ providers, now: T + 2 });
			expect(providers.claude.calls.identify).toBe(1);
			providers.claude.installed = cred('B');
			const state = await collectState({ providers, now: T + 3 });
			expect(providers.claude.calls.identify).toBe(2);
			expect(state.providers.claude.activeAccountId).toBeDefined();
		});
	});

	test('when the service cannot say whose login is installed, the saved copy settles it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			providers.claude.identifyFails = true;
			const state = await collectState({ providers, now: T });
			expect(state.providers.claude.activeAccountId).toBe(a.id);
		});
	});

	test('an explicit refresh inside the floor keeps the reading it has', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await collectState({ providers, now: T });
			const reads = providers.claude.calls.fetchUsage;
			await collectState({ providers, now: T + 30_000, force: true });
			expect(providers.claude.calls.fetchUsage).toBe(reads);
			await collectState({ providers, now: T + 61_000, force: true });
			expect(providers.claude.calls.fetchUsage).toBe(reads + 2);
		});
	});
});

describe('what a failed read says', () => {
	test.each([
		['usage request failed with 401', 'the saved login no longer works'],
		['usage request failed with 429', 'read too often, waiting a while'],
		['usage request failed with 503', 'the service had a problem'],
		['The operation timed out', 'the service took too long to answer'],
		['fetch failed', 'could not reach the service'],
		['Unexpected token < in JSON', 'the service sent an unreadable answer'],
		['no saved login', 'no saved login'],
	])('"%s" reads as "%s"', (raw, plain) => {
		expect(plainError(new Error(raw))).toBe(plain);
	});
});
