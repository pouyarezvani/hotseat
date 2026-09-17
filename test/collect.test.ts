import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	ACTIVE_CALM_MS,
	CANDIDATE_MS,
	collectState,
	fingerprint,
	plainError,
} from '../src/core/collect.ts';
import { ServiceError } from '../src/core/errors.ts';
import { updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { prepareSession, sessionDir } from '../src/core/session.ts';
import type { AccountRecord, UsageSnapshot } from '../src/core/types.ts';
import { loadCredential, storeCredential } from '../src/core/vault.ts';
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
			expect(usage?.errorKind).toBe('throttled');
			expect(usage?.failedReads).toBeUndefined();
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

describe('what counts as a login that stopped working', () => {
	test('a throttled read is not counted, and is not tried again before the service says', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await collectState({ providers, now: T });
			providers.claude.failures.set(
				'B',
				new ServiceError('usage request failed with 429', 429, 120_000),
			);
			const later = T + CANDIDATE_MS + 1;
			const state = await collectState({ providers, now: later });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.errorKind).toBe('throttled');
			expect(usage?.failedReads).toBeUndefined();
			expect(usage?.retryAt).toBe(new Date(later + 120_000).toISOString());
			const reads = providers.claude.readsOf.get('B') ?? 0;
			await collectState({ providers, now: later + 60_000, force: true });
			expect(providers.claude.readsOf.get('B')).toBe(reads);
			await collectState({ providers, now: later + 121_000, force: true });
			expect(providers.claude.readsOf.get('B')).toBe(reads + 1);
		});
	});

	test('an outage or a timeout is shown but not counted', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.failures.set('B', new ServiceError('usage request failed with 503', 503));
			const state = await collectState({ providers, now: T });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.errorKind).toBe('service');
			expect(usage?.failedReads).toBeUndefined();
		});
	});

	test('a login the service refuses is counted', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.failures.set('B', new ServiceError('usage request failed with 401', 401));
			const state = await collectState({ providers, now: T });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.errorKind).toBe('auth');
			expect(usage?.failedReads).toBe(1);
		});
	});

	test('a saved login the service refuses to refresh is not retried until it changes', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.refreshFailures.set(
				'B',
				new ServiceError('token refresh failed with 400 invalid_grant', 400),
			);
			const state = await collectState({ providers, now: T });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.error).toBe(
				'the saved login no longer works - run hotseat add to sign in again',
			);
			expect(usage?.errorKind).toBe('auth');
			const refreshes = providers.claude.calls.refresh;
			await collectState({ providers, now: T + CANDIDATE_MS + 1 });
			await collectState({ providers, now: T + 2 * CANDIDATE_MS + 2 });
			expect(providers.claude.calls.refresh).toBe(refreshes);
			await storeCredential(b, cred('B2'));
			providers.claude.readings.set('B2', () => reading(10));
			await collectState({ providers, now: T + 3 * CANDIDATE_MS + 3 });
			expect(providers.claude.calls.refresh).toBe(refreshes + 1);
		});
	});
});

describe('a reading that says nothing', () => {
	test('does not replace a real one', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await collectState({ providers, now: T });
			providers.claude.readings.set('B', () => ({
				fetchedAt: 'x',
				windows: [
					{ key: 'five_hour', label: '5h', percent: 0 },
					{ key: 'seven_day', label: 'week', percent: 0 },
				],
			}));
			const state = await collectState({ providers, now: T + CANDIDATE_MS + 1 });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.windows.map((window) => window.percent)).toEqual([10, 5]);
			expect(usage?.error).toBeUndefined();
		});
	});

	test('a reset time missing from a new reading is carried forward while it is still ahead', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const reset = new Date(T + 5 * 3_600_000).toISOString();
			await collectState({ providers, now: T });
			providers.claude.readings.set('B', () => ({
				fetchedAt: 'x',
				windows: [
					{ key: 'five_hour', label: '5h', percent: 12 },
					{ key: 'seven_day', label: 'week', percent: 6 },
				],
			}));
			const state = await collectState({ providers, now: T + CANDIDATE_MS + 1 });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.windows.map((window) => [window.percent, window.resetsAt])).toEqual([
				[12, reset],
				[6, reset],
			]);
		});
	});
});

describe('the login in use on an idle machine', () => {
	test('is refreshed by hotseat when it expired and nothing is running', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			providers.claude.installed = cred('A', 100, T - 1000);
			providers.claude.rotate = '+';
			providers.claude.identities.set('A+', { email: 'a@example.com' });
			const state = await collectState({ providers, now: T });
			expect(providers.claude.calls.refresh).toBeGreaterThan(0);
			expect(providers.claude.installed?.token).toBe('A+');
			expect((await loadCredential(a))?.token).toBe('A+');
			const usage = state.providers.claude.accounts.find((account) => account.id === a.id)?.usage;
			expect(usage?.windows.length).toBe(2);
			expect(usage?.error).toBeUndefined();
		});
	});

	test('is left to a running agent, and the wait is not held against it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			await collectState({ providers, now: T });
			providers.claude.installed = cred('A', 100, T + ACTIVE_CALM_MS);
			providers.claude.running = [{ pid: 1, command: 'claude' }];
			providers.claude.failures.set('A', new ServiceError('usage request failed with 401', 401));
			const state = await collectState({ providers, now: T + ACTIVE_CALM_MS + 1 });
			const usage = state.providers.claude.accounts.find((account) => account.id === a.id)?.usage;
			expect(usage?.windows.length).toBe(2);
			expect(usage?.failedReads).toBeUndefined();
			expect(usage?.error).toContain('refresh');
			expect(providers.claude.refreshesOf.get('A') ?? 0).toBe(0);
			expect(providers.claude.installed?.token).toBe('A');
		});
	});
});

describe('an account open in another terminal', () => {
	test("is read with that terminal's own login and never refreshed from here", async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const session = await prepareSession(providers.claude, b);
			await providers.claude.session.writeLogin(session.dir, cred('B-session', 200));
			providers.claude.readings.set('B-session', () => reading(33));
			providers.claude.runningIn.add(sessionDir(providers.claude, b));
			const state = await collectState({ providers, now: T });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(usage?.windows[0]?.percent).toBe(33);
			expect(providers.claude.refreshesOf.get('B') ?? 0).toBe(0);
			expect(providers.claude.refreshesOf.get('B-session') ?? 0).toBe(0);
		});
	});
});

describe("the agent's own reading of the account in use", () => {
	test('is used when it is newer than ours, without a request, keeping the model limits we read', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			providers.claude.identities.set('A', {
				email: 'a@example.com',
				plan: 'max',
				accountId: 'acc-a',
			});
			providers.claude.readings.set('A', () => ({
				...reading(98),
				windows: [
					...reading(98).windows,
					{ key: 'weekly_scoped:fable', label: 'Fable', percent: 39 },
				],
			}));
			await collectState({ providers, now: T });
			const reads = providers.claude.readsOf.get('A') ?? 0;
			providers.claude.local = {
				accountId: 'acc-a',
				fetchedAtMs: T + 30_000,
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent: 99,
						resetsAt: new Date(T + 3_600_000).toISOString(),
					},
					{
						key: 'seven_day',
						label: 'week',
						percent: 23,
						resetsAt: new Date(T + 5 * 86_400_000).toISOString(),
					},
				],
			};
			const state = await collectState({ providers, now: T + 40_000 });
			const usage = state.providers.claude.accounts.find((account) => account.id === a.id)?.usage;
			expect(usage?.windows.map((window) => [window.label, window.percent])).toEqual([
				['5h', 99],
				['week', 23],
				['Fable', 39],
			]);
			expect(usage?.fetchedAt).toBe(new Date(T + 30_000).toISOString());
			expect(providers.claude.readsOf.get('A')).toBe(reads);
		});
	});

	test('an answer remembered by an older hotseat is asked once more, then left alone', async () => {
		await withHome(async (home) => {
			const { providers, a } = await world();
			providers.claude.identities.set('A', { email: 'a@example.com', accountId: 'acc-a' });
			// What an older hotseat wrote: no account id, and no record of having asked for one.
			await Bun.write(
				join(home, 'usage.json'),
				JSON.stringify({
					version: 2,
					entries: {},
					identities: { claude: { fingerprint: fingerprint(cred('A')), email: 'a@example.com' } },
				}),
			);
			await collectState({ providers, now: T });
			expect(providers.claude.calls.identify).toBe(1);
			providers.claude.local = {
				accountId: 'acc-a',
				fetchedAtMs: T + 30_000,
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent: 77,
						resetsAt: new Date(T + 3_600_000).toISOString(),
					},
				],
			};
			const state = await collectState({ providers, now: T + 40_000 });
			expect(
				state.providers.claude.accounts.find((account) => account.id === a.id)?.usage?.windows[0]
					?.percent,
			).toBe(77);
			await collectState({ providers, now: T + 50_000 });
			expect(providers.claude.calls.identify).toBe(1);
		});
	});

	test('a service that never names the account is not asked over and over', async () => {
		await withHome(async () => {
			const { providers } = await world();
			providers.claude.identities.set('A', { email: 'a@example.com' });
			await collectState({ providers, now: T });
			await collectState({ providers, now: T + 10_000 });
			await collectState({ providers, now: T + 20_000 });
			expect(providers.claude.calls.identify).toBe(1);
		});
	});

	test('is ignored when it is older than ours, or about someone else', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			providers.claude.identities.set('A', { email: 'a@example.com', accountId: 'acc-a' });
			await collectState({ providers, now: T });
			providers.claude.local = {
				accountId: 'acc-a',
				fetchedAtMs: T - 30_000,
				windows: [{ key: 'five_hour', label: '5h', percent: 1 }],
			};
			let state = await collectState({ providers, now: T + 10_000 });
			expect(
				state.providers.claude.accounts.find((account) => account.id === a.id)?.usage?.windows[0]
					?.percent,
			).toBe(50);
			providers.claude.local = {
				accountId: 'acc-someone-else',
				fetchedAtMs: T + 30_000,
				windows: [{ key: 'five_hour', label: '5h', percent: 1 }],
			};
			state = await collectState({ providers, now: T + 40_000 });
			expect(
				state.providers.claude.accounts.find((account) => account.id === a.id)?.usage?.windows[0]
					?.percent,
			).toBe(50);
		});
	});
});
