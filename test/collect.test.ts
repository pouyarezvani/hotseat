import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVE_CALM_MS, CANDIDATE_MS, collectState, plainError } from '../src/core/collect.ts';
import { publishState, saveInstalled, signInAgain } from '../src/core/enroll.ts';
import { ServiceError } from '../src/core/errors.ts';
import { acquireLock } from '../src/core/fs.ts';
import { hotseatHome, usageCachePath } from '../src/core/paths.ts';
import { loadRegistry, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { renewInstalled, renewSaved } from '../src/core/renew.ts';
import { adoptIfNewer, prepareSession, sessionDir } from '../src/core/session.ts';
import { activate } from '../src/core/switch.ts';
import { holdSwitch } from '../src/core/switch-lock.ts';
import { exportAccounts, importAccounts } from '../src/core/transfer.ts';
import type { AccountRecord, UsageSnapshot } from '../src/core/types.ts';
import { fingerprint, loadCredential, storeCredential } from '../src/core/vault.ts';
import { cred, type FakeProvider, fakeProviders, tokenOf } from './fake-provider.ts';
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
			expect(usage?.error).toBe('the saved login no longer works - sign in to it again');
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

describe('publishing the board after a change', () => {
	test('reads nothing that is not due, so a switch is not held up by the network', async () => {
		await withHome(async (home) => {
			const { providers, a } = await world();
			await collectState({ providers, now: T });
			const reads = providers.claude.calls.fetchUsage;
			await publishState({ providers, now: T + 61_000 });
			expect(providers.claude.calls.fetchUsage).toBe(reads);
			const published = await Bun.file(join(home, 'state.json')).json();
			expect(published.providers.claude.activeAccountId).toBe(a.id);
		});
	});

	test('reads every account again when asked to, as adding an account does', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await collectState({ providers, now: T });
			const reads = providers.claude.calls.fetchUsage;
			await publishState({ providers, now: T + 61_000, force: true });
			expect(providers.claude.calls.fetchUsage).toBe(reads + 2);
		});
	});
});

describe('the saved copy of the account in use', () => {
	test('is kept current as the agent rotates its token, so it never goes stale', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			await collectState({ providers, now: T });
			// The agent refreshes its login, which replaces the refresh token.
			providers.claude.installed = cred('A-rotated', 200);
			providers.claude.identities.set('A-rotated', { email: 'a@example.com' });
			providers.claude.readings.set('A-rotated', () => reading(55));
			await collectState({ providers, now: T + ACTIVE_CALM_MS + 1 });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-rotated');
		});
	});

	test('is not replaced by an installed login older than it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			await storeCredential(a, cred('A-signed-in-again', 300));
			providers.claude.installed = cred('A-old', 100);
			providers.claude.identities.set('A-old', { email: 'a@example.com' });
			providers.claude.readings.set('A-old', () => reading(55));
			await collectState({ providers, now: T });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-signed-in-again');
		});
	});
});

describe('when the login in use cannot be confirmed', () => {
	/** The agent rotated the login since hotseat saved it, and the service cannot be asked whose it is. */
	async function unconfirmed(): Promise<Awaited<ReturnType<typeof world>>> {
		const base = await world();
		await updateRegistry((registry) => {
			registry.active.claude = base.a.id;
		});
		await collectState({ providers: base.providers, now: T });
		base.providers.claude.installed = cred('A-rotated', 200);
		base.providers.claude.identifyFails = true;
		// The saved copy's refresh token has been used up by the agent's rotation.
		base.providers.claude.refreshFailures.set(
			'A',
			new ServiceError('token refresh failed with 400 invalid_grant', 400),
		);
		return base;
	}

	test('the account last put in use is not read or refreshed from its saved copy', async () => {
		await withHome(async () => {
			const { providers } = await unconfirmed();
			await collectState({ providers, now: T + CANDIDATE_MS + 1 });
			expect(providers.claude.refreshesOf.get('A') ?? 0).toBe(0);
			expect(providers.claude.readsOf.get('A') ?? 0).toBe(1);
		});
	});

	test('it stays shown in use with its last numbers, and nothing is marked as a dead login', async () => {
		await withHome(async () => {
			const { providers, a, b } = await unconfirmed();
			const state = await collectState({ providers, now: T + CANDIDATE_MS + 1 });
			expect(state.providers.claude.activeAccountId).toBe(a.id);
			const usage = state.providers.claude.accounts.find((x) => x.id === a.id)?.usage;
			expect(usage?.windows.map((w) => w.percent)).toEqual([50, 25]);
			expect(usage?.errorKind).not.toBe('auth');
			expect(usage?.failedReads).toBeUndefined();
			expect(usage?.error).toBe('could not confirm which login is in use - trying again shortly');
			// Every other account is read as usual.
			const other = state.providers.claude.accounts.find((x) => x.id === b.id)?.usage;
			expect(other?.error).toBeUndefined();
		});
	});

	test('once it can be confirmed again, it is read with the installed login and its saved copy catches up', async () => {
		await withHome(async () => {
			const { providers, a } = await unconfirmed();
			await collectState({ providers, now: T + CANDIDATE_MS + 1 });
			providers.claude.identifyFails = false;
			providers.claude.identities.set('A-rotated', { email: 'a@example.com' });
			providers.claude.readings.set('A-rotated', () => reading(61));
			const state = await collectState({ providers, now: T + 2 * CANDIDATE_MS + 2 });
			const usage = state.providers.claude.accounts.find((x) => x.id === a.id)?.usage;
			expect(usage?.windows[0]?.percent).toBe(61);
			expect(usage?.error).toBeUndefined();
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-rotated');
		});
	});

	test('an installed login matching any saved copy is recognised without asking, not only the last one put in use', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await updateRegistry((registry) => {
				registry.active.claude = b.id;
			});
			providers.claude.identifyFails = true;
			const state = await collectState({ providers, now: T });
			expect(state.providers.claude.activeAccountId).toBe(
				(await loadRegistry()).accounts.find((x) => x.email === 'a@example.com')?.id,
			);
		});
	});
});

describe('renewing a saved login', () => {
	const halfAwake = async (): Promise<boolean> => false;

	test('never starts while the Mac is only half awake, where its answer could be lost', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await storeCredential(b, cred('B', 0, T - MIN));
			providers.claude.rotate = '+';
			const state = await collectState({ providers, now: T, awake: halfAwake });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(providers.claude.refreshesOf.get('B')).toBeUndefined();
			expect(usage?.errorKind).not.toBe('auth');
			expect(usage?.failedReads).toBeUndefined();
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B');
		});
	});

	test('a login still valid is read while the Mac is half awake, without renewing it', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await storeCredential(b, cred('B', 0, T + 60 * MIN));
			providers.claude.rotate = '+';
			const state = await collectState({ providers, now: T, awake: halfAwake });
			const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
			expect(providers.claude.refreshesOf.get('B')).toBeUndefined();
			expect(providers.claude.readsOf.get('B')).toBe(1);
			expect(usage?.windows[0]?.percent).toBe(10);
		});
	});

	test('resumes once the Mac is fully awake', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await storeCredential(b, cred('B', 0, T - MIN));
			providers.claude.rotate = '+';
			await collectState({ providers, now: T, awake: halfAwake });
			await collectState({ providers, now: T + CANDIDATE_MS + 1, awake: async () => true });
			expect(providers.claude.refreshesOf.get('B')).toBe(1);
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B+');
		});
	});

	test('is done by one process at a time, so none presents a token another already spent', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.rotate = '+';
			providers.claude.spends = true;
			providers.claude.refreshDelayMs = 60;
			const states = await Promise.all([
				collectState({ force: true, providers, now: T }),
				collectState({ force: true, providers, now: T }),
			]);
			expect(providers.claude.refreshesOf.get('B')).toBe(1);
			for (const state of states) {
				const usage = state.providers.claude.accounts.find((account) => account.id === b.id)?.usage;
				expect(usage?.errorKind).not.toBe('auth');
			}
			expect(tokenOf((await loadCredential(b)) ?? {})).toStartWith('B+');
		});
	});

	test('the login in use is not renewed by hotseat while the Mac is half awake', async () => {
		await withHome(async () => {
			const { providers } = await world();
			providers.claude.installed = cred('A', 0, T - MIN);
			providers.claude.rotate = '+';
			await collectState({ providers, now: T, awake: halfAwake });
			expect(providers.claude.refreshesOf.get('A')).toBeUndefined();
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});
});

describe('renewing the login in use', () => {
	test('a renewal that cannot be installed is kept, and installed next time without spending its token again', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			providers.claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			providers.claude.rotate = '+';
			providers.claude.spends = true;
			providers.claude.writeFailure = new Error('keychain locked');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
			providers.claude.writeFailure = null;
			const state = await collectState({
				providers,
				now: T + MIN,
				force: true,
				awake: async () => true,
			});
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A+');
			expect(providers.claude.refreshesOf.get('A')).toBe(1);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A+');
			expect(
				state.providers.claude.accounts.find((account) => account.id === a.id)?.usage?.error,
			).toBeUndefined();
		});
	});
});

describe('a kept renewal whose login was switched away from', () => {
	test('is filed under its account, not lost, and that account is never renewed from its spent token', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			claude.spends = true;
			claude.writeFailure = new Error('keychain locked');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			claude.writeFailure = null;
			claude.installed = cred('B');
			await updateRegistry((registry) => {
				registry.active.claude = b.id;
			});
			const state = await collectState({
				providers,
				now: T + MIN,
				force: true,
				awake: async () => true,
			});
			expect(claude.refreshesOf.get('A')).toBe(1);
			expect(tokenOf((await loadCredential(a)) ?? {})).toStartWith('A+');
			const usage = state.providers.claude.accounts.find((account) => account.id === a.id)?.usage;
			expect(usage?.error).toBeUndefined();
		});
	});
});

describe('a renewal saved but never installed', () => {
	test('stays with its account when another login is put in use and renewed', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			claude.spends = true;
			claude.writeFailure = new Error('keychain locked');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			claude.writeFailure = null;
			claude.identities.set('B2', { email: 'b@example.com' });
			claude.installed = cred('B2', 0, T - MIN);
			await storeCredential(b, cred('B2', 0, T - MIN));
			await updateRegistry((registry) => {
				registry.active.claude = b.id;
			});
			await renewInstalled(claude, b, cred('B2', 0, T - MIN), () => true);
			expect(tokenOf(claude.installed ?? {})).toBe('B2+');
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B2+');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A+');
			expect(claude.refreshesOf.get('A')).toBe(1);
		});
	});
});

describe('a renewal that could not be installed, for a login the service cannot name', () => {
	test('is still put in once installing works again', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.identities.delete('A');
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			claude.spends = true;
			claude.writeFailure = new Error('keychain locked');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A+');
			claude.writeFailure = null;
			await collectState({ providers, now: T + MIN, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('A+');
			expect(claude.refreshesOf.get('A')).toBe(1);
		});
	});
});

describe('a renewal saved but not installed when hotseat stopped', () => {
	test('is installed by the next run, which knows nothing the stopped one remembered', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.identities.delete('A');
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			claude.spends = true;
			claude.writeFailure = new Error('stopped before installing');
			await expect(renewInstalled(claude, a, cred('A', 0, T - MIN), () => true)).rejects.toThrow(
				'stopped before installing',
			);
			claude.writeFailure = null;
			await collectState({ providers, now: T + MIN, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('A+');
			expect(claude.refreshesOf.get('A')).toBe(1);
		});
	});
});

describe('renewing the login in use while something else changes it', () => {
	test('a login put in from outside while the renewal waits on the service is not replaced', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			claude.refreshDelayMs = 50;
			const renewing = renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			await Bun.sleep(20);
			claude.installed = cred('X');
			await renewing;
			expect(tokenOf(claude.installed ?? {})).toBe('X');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A+');
		});
	});

	test("a login put in after the one named is never replaced by the named account's login", async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			await storeCredential(a, cred('A2', 5));
			claude.installed = cred('B', 0, T - MIN);
			const named = cred('A', 0, T - MIN);
			expect(tokenOf((await renewInstalled(claude, a, named, () => true)) ?? {})).toBe('B');
			expect(tokenOf(claude.installed ?? {})).toBe('B');
		});
	});

	test('a login that changed hands since it was named is left alone', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('B', 0, T - MIN);
			claude.rotate = '+';
			expect(
				tokenOf((await renewInstalled(claude, a, cred('B', 0, T - MIN), () => true)) ?? {}),
			).toBe('B');
			expect(claude.refreshesOf.get('B') ?? 0).toBe(0);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
		});
	});

	test('a switch that finishes first is never undone by the renewal', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			claude.refreshDelayMs = 50;
			const switching = await holdSwitch('claude');
			const renewing = renewInstalled(claude, a, cred('A', 0, T - MIN), (login) => {
				const expires = claude.expiresAt(login);
				return expires !== undefined && expires <= T;
			});
			await Bun.sleep(30);
			claude.installed = cred('B');
			await switching.release();
			await renewing;
			expect(tokenOf(claude.installed ?? {})).toBe('B');
			expect(claude.refreshesOf.get('A') ?? 0).toBe(0);
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B');
		});
	});

	test('a renewal is never saved over a sign-in made while it was under way', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			claude.refreshDelayMs = 50;
			const renewing = renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			await Bun.sleep(20);
			await storeCredential(a, cred('NEW-SIGN-IN', 9));
			await renewing;
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW-SIGN-IN');
		});
	});

	test('the sign-in kept over a renewal still goes in after installing it failed and hotseat stopped', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.identities.delete('A');
			claude.identities.set('NEW-SIGN-IN', { email: 'a@example.com' });
			claude.readings.set('NEW-SIGN-IN', () => reading(20));
			claude.rotate = '+';
			claude.refreshDelayMs = 50;
			claude.writeFailure = new Error('security: the keychain is locked');
			const renewing = renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			await Bun.sleep(20);
			await storeCredential(a, cred('NEW-SIGN-IN'));
			await expect(renewing).rejects.toThrow('the keychain is locked');
			expect(tokenOf(claude.installed ?? {})).toBe('A');
			claude.writeFailure = null;
			claude.rotate = '';
			claude.refreshDelayMs = 0;
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('NEW-SIGN-IN');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW-SIGN-IN');
			expect(claude.refreshesOf.get('A')).toBe(1);
		});
	});

	test('a sign-in kept over a renewal that could not be installed is not replaced by the spent login', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.identities.delete('A');
			claude.identities.set('NEW-SIGN-IN', { email: 'a@example.com' });
			claude.readings.set('NEW-SIGN-IN', () => reading(20));
			claude.rotate = '+';
			claude.writeFailure = new Error('security: the keychain is locked');
			claude.duringRefresh = async (login) => {
				if (tokenOf(login) === 'A') await storeCredential(a, cred('NEW-SIGN-IN'));
			};
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('A');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW-SIGN-IN');
			claude.writeFailure = null;
			claude.duringRefresh = null;
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('NEW-SIGN-IN');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW-SIGN-IN');
			expect(claude.refreshesOf.get('A')).toBe(1);
		});
	});

	test('a login put in from outside while recovery reads the saved one is not replaced', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('NEW-SIGN-IN', 9));
			claude.afterRead = () => {
				claude.installed = cred('OUTSIDE');
				claude.afterRead = null;
			};
			await renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			expect(tokenOf(claude.installed ?? {})).toBe('OUTSIDE');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW-SIGN-IN');
		});
	});

	test('the sign-in kept over a renewal is the login put in use, and stays saved after the next pass', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.identities.set('A+', { email: 'a@example.com' });
			claude.identities.set('NEW-SIGN-IN', { email: 'a@example.com' });
			claude.readings.set('NEW-SIGN-IN', () => reading(20));
			claude.rotate = '+';
			claude.refreshDelayMs = 50;
			const renewing = renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			await Bun.sleep(20);
			// Older than the renewal, as a Codex sign-in made before the refresh
			// answered is by its last_refresh.
			await storeCredential(a, cred('NEW-SIGN-IN'));
			await renewing;
			expect(tokenOf(claude.installed ?? {})).toBe('NEW-SIGN-IN');
			claude.rotate = '';
			claude.refreshDelayMs = 0;
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('NEW-SIGN-IN');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW-SIGN-IN');
		});
	});
});

describe('keeping the saved copy of the login in use current', () => {
	test('a login the agent renewed after hotseat put it in use replaces its saved copy', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const claude = providers.claude;
			await activate('claude', b.id, { providers, now: T });
			claude.installed = cred('B2', 5);
			claude.identities.set('B2', { email: 'b@example.com' });
			claude.readings.set('B2', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B2');
			claude.installed = cred('B3', 7);
			claude.identities.set('B3', { email: 'b@example.com' });
			claude.readings.set('B3', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B3');
		});
	});

	test('a login signed in to again and put in use is kept current as the agent renews it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === a.id);
				if (record) record.inUseFrom = fingerprint(cred('A'));
			});
			claude.identities.set('A-NEW', { email: 'a@example.com' });
			await signInAgain({
				providerId: 'claude',
				account: a,
				providers,
				now: T,
				login: async () => cred('A-NEW'),
			});
			expect(tokenOf(claude.installed ?? {})).toBe('A-NEW');
			claude.installed = cred('A-NEW2', 5);
			claude.identities.set('A-NEW2', { email: 'a@example.com' });
			claude.readings.set('A-NEW2', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-NEW2');
		});
	});

	test('the login in use, once saved, is kept current as the agent renews it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === a.id);
				if (record) record.inUseFrom = fingerprint(cred('A-OLD'));
			});
			claude.installed = cred('A-CUR');
			claude.identities.set('A-CUR', { email: 'a@example.com' });
			const saved = await saveInstalled('claude', { providers });
			expect(saved?.account.id).toBe(a.id);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-CUR');
			expect((await loadRegistry()).active.claude).toBe(a.id);
			claude.installed = cred('A-CUR2', 5);
			claude.identities.set('A-CUR2', { email: 'a@example.com' });
			claude.readings.set('A-CUR2', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-CUR2');
		});
	});

	test('a sign-in saved while another login of the account is in use is never replaced by it', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const claude = providers.claude;
			await activate('claude', b.id, { providers, now: T });
			await storeCredential(b, cred('SIGN-IN'));
			claude.installed = cred('B2', 5);
			claude.identities.set('B2', { email: 'b@example.com' });
			claude.readings.set('B2', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('SIGN-IN');
		});
	});

	test('a pass that read a login no longer in use never saves it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.afterRead = async () => {
				claude.afterRead = null;
				claude.installed = cred('SIGN-IN');
				await storeCredential(a, cred('SIGN-IN'));
				await updateRegistry((registry) => {
					const record = registry.accounts.find((entry) => entry.id === a.id);
					if (record) record.inUseFrom = fingerprint(cred('SIGN-IN'));
				});
			};
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('SIGN-IN');
		});
	});

	test('a sign-in saved while a recovered login goes in stays saved after the next pass', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('RENEWAL', 9));
			claude.identities.set('RENEWAL', { email: 'a@example.com' });
			claude.identities.set('SIGN-IN', { email: 'a@example.com' });
			claude.readings.set('RENEWAL', () => reading(20));
			claude.readings.set('SIGN-IN', () => reading(20));
			let reads = 0;
			claude.afterRead = async () => {
				reads += 1;
				if (reads === 2) await storeCredential(a, cred('SIGN-IN'));
			};
			await renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			claude.afterRead = null;
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('SIGN-IN');
		});
	});
});

describe('stopping right after a login goes in', () => {
	// The install succeeds and hotseat stops at its next step: nothing it
	// writes after the install lands, as when the process is killed there.
	function stopAfterNextWrite(provider: FakeProvider): void {
		provider.afterWrite = async () => {
			provider.afterWrite = null;
			await chmod(hotseatHome(), 0o500);
		};
	}

	function resume(): Promise<void> {
		return chmod(hotseatHome(), 0o700);
	}

	function marked(account: AccountRecord, login: ReturnType<typeof cred>): Promise<void> {
		return updateRegistry((registry) => {
			const record = registry.accounts.find((entry) => entry.id === account.id);
			if (record) record.inUseFrom = fingerprint(login);
		});
	}

	function agentRenews(
		provider: FakeProvider,
		from: string,
		to: string,
		issued: number,
		email: string,
	): void {
		provider.installed = cred(to, issued);
		provider.refreshFailures.set(
			from,
			new ServiceError('token refresh failed with 400: invalid_grant', 400),
		);
		provider.identities.set(to, { email });
		provider.readings.set(to, () => reading(10));
	}

	test("a switch that stopped once the login was in still keeps the agent's renewals, and switching back works", async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			const claude = providers.claude;
			await marked(b, cred('B-OLD'));
			claude.rotate = '+';
			stopAfterNextWrite(claude);
			await expect(activate('claude', b.id, { providers, now: T })).rejects.toThrow('EACCES');
			await resume();
			expect(tokenOf(claude.installed ?? {})).toBe('B+');
			claude.rotate = '';
			agentRenews(claude, 'B+', 'B++', 5, 'b@example.com');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B++');
			claude.rotate = '+';
			await activate('claude', a.id, { providers, now: T });
			await activate('claude', b.id, { providers, now: T });
			expect(tokenOf(claude.installed ?? {})).toBe('B+++');
		});
	});

	test("renewing the login in use, stopped once the renewal was in, still keeps the agent's renewals", async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			await marked(a, cred('A', 0, T - MIN));
			claude.rotate = '+';
			stopAfterNextWrite(claude);
			await expect(renewInstalled(claude, a, cred('A', 0, T - MIN), () => true)).rejects.toThrow(
				'EACCES',
			);
			await resume();
			expect(tokenOf(claude.installed ?? {})).toBe('A+');
			claude.rotate = '';
			agentRenews(claude, 'A+', 'A++', 5, 'a@example.com');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A++');
		});
	});

	test("recovering the login in use, stopped once the saved login was in, still keeps the agent's renewals", async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('NEW', 9));
			await marked(a, cred('A', 0, T - MIN));
			stopAfterNextWrite(claude);
			await expect(renewInstalled(claude, a, cred('A', 0, T - MIN), () => true)).rejects.toThrow(
				'EACCES',
			);
			await resume();
			expect(tokenOf(claude.installed ?? {})).toBe('NEW');
			agentRenews(claude, 'NEW', 'NEW2', 12, 'a@example.com');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW2');
		});
	});

	test("renewing the login in use, stopped once a sign-in kept over the renewal was in, still keeps the agent's renewals", async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			await marked(a, cred('A', 0, T - MIN));
			claude.identities.set('SIGN-IN', { email: 'a@example.com' });
			claude.rotate = '+';
			claude.duringRefresh = async (login) => {
				if (tokenOf(login) === 'A') await storeCredential(a, cred('SIGN-IN'));
			};
			stopAfterNextWrite(claude);
			await expect(renewInstalled(claude, a, cred('A', 0, T - MIN), () => true)).rejects.toThrow(
				'EACCES',
			);
			await resume();
			expect(tokenOf(claude.installed ?? {})).toBe('SIGN-IN');
			claude.rotate = '';
			claude.duringRefresh = null;
			agentRenews(claude, 'SIGN-IN', 'SIGN-IN2', 5, 'a@example.com');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('SIGN-IN2');
		});
	});

	test('a sign-in that could not be put in goes in once the login it replaces expires', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			claude.identities.set('A-NEW', { email: 'a@example.com' });
			claude.readings.set('A-NEW', () => reading(10));
			claude.writeFailure = new Error('security: the keychain is locked');
			await expect(
				signInAgain({
					providerId: 'claude',
					account: a,
					providers,
					now: T,
					login: async () => cred('A-NEW'),
				}),
			).rejects.toThrow('the keychain is locked');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-NEW');
			claude.writeFailure = null;
			claude.identities.delete('A');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('A-NEW');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-NEW');
		});
	});

	test("signing in again, stopped once the sign-in was in, still keeps the agent's renewals", async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			await marked(a, cred('OTHER'));
			claude.identities.set('A-NEW', { email: 'a@example.com' });
			stopAfterNextWrite(claude);
			await expect(
				signInAgain({
					providerId: 'claude',
					account: a,
					providers,
					now: T,
					login: async () => cred('A-NEW'),
				}),
			).rejects.toThrow('EACCES');
			await resume();
			expect(tokenOf(claude.installed ?? {})).toBe('A-NEW');
			agentRenews(claude, 'A-NEW', 'A-NEW2', 5, 'a@example.com');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-NEW2');
		});
	});
});

describe('putting a login in use when something goes wrong', () => {
	test('a sign-in that could not be put in is not replaced by the old login the agent goes on renewing', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.identities.set('SIGN-IN', { email: 'a@example.com' });
			claude.writeFailure = new Error('security: the keychain is locked');
			await expect(
				signInAgain({
					providerId: 'claude',
					account: a,
					providers,
					now: T,
					login: async () => cred('SIGN-IN'),
				}),
			).rejects.toThrow('the keychain is locked');
			claude.writeFailure = null;
			expect(tokenOf(claude.installed ?? {})).toBe('A');
			claude.installed = cred('A2', 5);
			claude.identities.set('A2', { email: 'a@example.com' });
			claude.readings.set('A2', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('SIGN-IN');
		});
	});

	test('a login put in from outside while signing in again waits on the registry is not replaced', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.identities.set('A-NEW', { email: 'a@example.com' });
			claude.identities.set('OUTSIDE', { email: 'b@example.com' });
			const registry = await acquireLock(hotseatHome());
			const signing = signInAgain({
				providerId: 'claude',
				account: a,
				providers,
				now: T,
				login: async () => cred('A-NEW'),
			});
			await Bun.sleep(50);
			claude.installed = cred('OUTSIDE');
			await registry.release();
			await signing;
			expect(tokenOf(claude.installed ?? {})).toBe('OUTSIDE');
		});
	});

	test('a login put in from outside while recovery waits on the registry is not replaced', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('NEW', 9));
			const registry = await acquireLock(hotseatHome());
			const recovering = renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			await Bun.sleep(50);
			claude.installed = cred('OUTSIDE');
			await registry.release();
			await recovering;
			expect(tokenOf(claude.installed ?? {})).toBe('OUTSIDE');
		});
	});

	test('a login put in from outside after a switch last checked is not replaced', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const claude = providers.claude;
			claude.identities.set('OUTSIDE', { email: 'outside@example.com' });
			let reads = 0;
			claude.afterRead = () => {
				reads += 1;
				if (reads === 3) claude.installed = cred('OUTSIDE');
			};
			await expect(activate('claude', b.id, { providers, now: T })).rejects.toThrow(
				'the login in use changed while switching',
			);
			expect(tokenOf(claude.installed ?? {})).toBe('OUTSIDE');
		});
	});

	test('the saved login is never updated from the login in use while a login is being put in', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			const switching = await holdSwitch('claude');
			await storeCredential(a, cred('SIGN-IN'));
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === a.id);
				if (!record) return;
				record.inUseFrom = fingerprint(cred('SIGN-IN'));
				record.renewedFrom = fingerprint(cred('A'));
			});
			claude.installed = cred('A2', 5);
			claude.identities.set('A2', { email: 'a@example.com' });
			claude.readings.set('A2', () => reading(10));
			const reading2 = collectState({ providers, now: T, force: true, awake: async () => true });
			await Bun.sleep(100);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('SIGN-IN');
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === a.id);
				if (record) record.inUseFrom = fingerprint(cred('A'));
			});
			await switching.release();
			await reading2;
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('SIGN-IN');
		});
	});

	test('a login that never went in because hotseat stopped first does not let the old one take over', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			await storeCredential(a, cred('NEW', 9));
			let reads = 0;
			claude.afterRead = async () => {
				reads += 1;
				if (reads === 2) {
					claude.afterRead = null;
					await chmod(hotseatHome(), 0o500);
					throw new Error('hotseat stopped');
				}
			};
			await expect(renewInstalled(claude, a, cred('A'), () => true)).rejects.toThrow('EACCES');
			await chmod(hotseatHome(), 0o700);
			expect(tokenOf(claude.installed ?? {})).toBe('A');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			claude.installed = cred('A2', 12);
			claude.identities.set('A2', { email: 'a@example.com' });
			claude.readings.set('A2', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW');
		});
	});

	test('a pass holding a login read before a replacement went in does not undo the record of it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			claude.installed = cred('NEW', 9);
			await storeCredential(a, cred('NEW', 9));
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === a.id);
				if (!record) return;
				record.inUseFrom = fingerprint(cred('NEW', 9));
				record.renewedFrom = fingerprint(cred('A'));
			});
			await adoptIfNewer(claude, a, cred('A'));
			claude.installed = cred('NEW2', 12);
			claude.identities.set('NEW2', { email: 'a@example.com' });
			claude.readings.set('NEW2', () => reading(10));
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('NEW2');
		});
	});

	test('the switch lock is held until a recovered or renewed login is in', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const claude = providers.claude;
			const lockFree: boolean[] = [];
			claude.afterWrite = async () => {
				const probe = await acquireLock(hotseatHome(), 20, 'switch-claude.lock').catch(() => null);
				lockFree.push(probe !== null);
				await probe?.release();
			};
			claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('NEW', 9));
			await renewInstalled(claude, a, cred('A', 0, T - MIN), () => true);
			claude.installed = cred('NEW', 9, T - MIN);
			await storeCredential(a, cred('NEW', 9, T - MIN));
			claude.rotate = '+';
			await renewInstalled(claude, a, cred('NEW', 9, T - MIN), () => true);
			expect(tokenOf(claude.installed ?? {})).toBe('NEW+');
			expect(lockFree).toEqual([false, false]);
		});
	});

	test('accounts brought in from an export keep a sign-in from being replaced by the login in use', async () => {
		const file = join(tmpdir(), `hotseat-export-${process.pid}-${Date.now()}.json`);
		try {
			const providers = await withHome(async () => {
				const { providers, b } = await world();
				await activate('claude', b.id, { providers, now: T });
				await storeCredential(b, cred('SIGN-IN'));
				await exportAccounts(file);
				return providers;
			});
			await withHome(async () => {
				const claude = providers.claude;
				await importAccounts(file);
				claude.installed = cred('B2', 5);
				claude.identities.set('B2', { email: 'b@example.com' });
				claude.readings.set('B2', () => reading(10));
				await collectState({ providers, now: T, force: true, awake: async () => true });
				const b = (await loadRegistry()).accounts.find((entry) => entry.email === 'b@example.com');
				expect(tokenOf(b?.login ?? {})).toBe('SIGN-IN');
			});
		} finally {
			await rm(file, { force: true });
		}
	});

	test('a session folder that cannot be looked at is not taken for no session', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const claude = providers.claude;
			claude.rotate = '+';
			const parent = join(hotseatHome(), 'sessions', 'claude');
			await mkdir(sessionDir(claude, b), { recursive: true });
			await chmod(parent, 0o000);
			try {
				await expect(renewSaved(claude, b)).rejects.toThrow('EACCES');
				expect(claude.refreshesOf.get('B') ?? 0).toBe(0);
			} finally {
				await chmod(parent, 0o700);
			}
		});
	});
});

describe('renewing a saved login while it is signed in to again', () => {
	test('the sign-in saved while the renewal waits on the service is kept', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const claude = providers.claude;
			claude.rotate = '+';
			claude.refreshDelayMs = 50;
			const renewing = renewSaved(claude, b);
			await Bun.sleep(20);
			await storeCredential(b, cred('NEW-SIGN-IN', 9));
			await renewing;
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('NEW-SIGN-IN');
		});
	});

	test('switching to the account puts in the sign-in kept over the renewal, and it stays saved after the next pass', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const claude = providers.claude;
			claude.identities.set('B+', { email: 'b@example.com' });
			claude.identities.set('NEW-SIGN-IN', { email: 'b@example.com' });
			claude.readings.set('NEW-SIGN-IN', () => reading(20));
			claude.rotate = '+';
			claude.refreshDelayMs = 50;
			const switching = activate('claude', b.id, { providers, now: T });
			await Bun.sleep(20);
			await storeCredential(b, cred('NEW-SIGN-IN'));
			await switching;
			expect(tokenOf(claude.installed ?? {})).toBe('NEW-SIGN-IN');
			claude.rotate = '';
			claude.refreshDelayMs = 0;
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(tokenOf(claude.installed ?? {})).toBe('NEW-SIGN-IN');
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('NEW-SIGN-IN');
		});
	});
});

describe('renewing one login from two places at once', () => {
	test('a saved copy and the installed login holding one token are renewed once, never twice', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const claude = providers.claude;
			claude.installed = cred('B', 0, T - MIN);
			await storeCredential(b, cred('B', 0, T - MIN));
			claude.rotate = '+';
			claude.spends = true;
			claude.refreshDelayMs = 50;
			const results = await Promise.allSettled([
				renewSaved(claude, b),
				renewInstalled(claude, b, cred('B', 0, T - MIN), () => true),
			]);
			expect(claude.refreshesOf.get('B')).toBe(1);
			expect(tokenOf(claude.installed ?? {})).toBe('B+');
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B+');
			const record = (await loadRegistry()).accounts.find((entry) => entry.id === b.id);
			expect(record?.renewedFrom).toBeUndefined();
			expect(record?.inUseFrom).toBe(fingerprint(cred('B+', 1)));
			expect(
				results.flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : [])),
			).not.toContainEqual(expect.stringContaining('invalid_grant'));
		});
	});
});

describe('not knowing what is in use', () => {
	test('a login in use that cannot be read is neither renewed nor read from its saved copy', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.rotate = '+';
			providers.claude.readFailure = new Error('security: timed out');
			const state = await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(providers.claude.refreshesOf.get('A') ?? 0).toBe(0);
			expect(providers.claude.readsOf.get('A') ?? 0).toBe(0);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
			const byId = new Map(state.providers.claude.accounts.map((account) => [account.id, account]));
			expect(byId.get(a.id)?.usage?.error).toBe(
				'could not confirm which login is in use - trying again shortly',
			);
			expect(byId.get(b.id)?.usage?.windows.length).toBe(2);
		});
	});

	test('an expired login in use is not renewed while nobody can tell whether an agent is using it', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			providers.claude.installed = cred('A', 0, T - MIN);
			await storeCredential(a, cred('A', 0, T - MIN));
			providers.claude.rotate = '+';
			providers.claude.scanFailure = new Error('could not list processes');
			await collectState({ providers, now: T, force: true, awake: async () => true });
			expect(providers.claude.refreshesOf.get('A') ?? 0).toBe(0);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});
});

describe('a window that has reset', () => {
	const HOUR = 3_600_000;
	function split(
		short: number,
		shortReset: number,
		week: number,
		weekReset: number,
	): UsageSnapshot {
		return {
			fetchedAt: new Date(T).toISOString(),
			windows: [
				{
					key: 'five_hour',
					label: '5h',
					percent: short,
					resetsAt: new Date(shortReset).toISOString(),
				},
				{
					key: 'seven_day',
					label: 'week',
					percent: week,
					resetsAt: new Date(weekReset).toISOString(),
				},
			],
		};
	}

	test('reads as empty once its reset has passed, even while the account cannot be read again', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.readings.set('B', () => split(100, T + HOUR, 50, T + 100 * HOUR));
			await collectState({ providers, now: T, force: true });
			providers.claude.failures.set('B', new Error('fetch failed'));
			const later = await collectState({ providers, now: T + HOUR + 5 * MIN, force: true });
			const windows = later.providers.claude.accounts.find((account) => account.id === b.id)?.usage
				?.windows;
			expect(windows?.find((window) => window.key === 'five_hour')?.percent).toBe(0);
			expect(windows?.find((window) => window.key === 'seven_day')?.percent).toBe(50);
		});
	});

	test('a fresh reading of all zeros replaces numbers whose windows have all reset', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.readings.set('B', () => split(100, T + HOUR, 100, T + 2 * HOUR));
			await collectState({ providers, now: T, force: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{ key: 'five_hour', label: '5h', percent: 0 },
					{ key: 'seven_day', label: 'week', percent: 0 },
				],
			}));
			const later = await collectState({ providers, now: T + 3 * HOUR, force: true });
			const windows = later.providers.claude.accounts.find((account) => account.id === b.id)?.usage
				?.windows;
			expect(windows?.map((window) => window.percent)).toEqual([0, 0]);
		});
	});
});

describe('two passes at once', () => {
	test('a slower pass carrying an older reading from the agent never replaces a newer one', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			await collectState({ providers, now: T, force: true });
			const other = fakeProviders();
			other.claude.installed = cred('A');
			other.claude.identities.set('A', { email: 'a@example.com', plan: 'max' });
			other.claude.identities.set('B', { email: 'b@example.com' });
			other.claude.readings.set('A', () => reading(50));
			other.claude.readings.set('B', () => reading(10));
			const local = (percent: number, at: number) => ({
				fetchedAtMs: at,
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent,
						resetsAt: new Date(T + 5 * 3_600_000).toISOString(),
					},
				],
			});
			providers.claude.local = local(20, T + 20_000);
			providers.claude.localDelayMs = 100;
			other.claude.local = local(95, T + 40_000);
			const slow = collectState({ providers, now: T + MIN });
			await Bun.sleep(20);
			await collectState({ providers: other, now: T + MIN });
			await slow;
			const stored = (await Bun.file(usageCachePath()).json()) as {
				entries: Record<string, { snapshot: UsageSnapshot }>;
			};
			const percent = stored.entries[a.id]?.snapshot.windows.find(
				(window) => window.key === 'five_hour',
			)?.percent;
			expect(percent).toBe(95);
		});
	});

	test('a slow pass that started first never replaces the newer reading of a later one', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.readings.set('B', () => reading(10));
			providers.claude.fetchDelayMs = 100;
			const slow = collectState({ providers, now: T, force: true });
			await Bun.sleep(20);
			providers.claude.fetchDelayMs = 0;
			providers.claude.readings.set('B', () => reading(95));
			await collectState({ providers, now: T + MIN, force: true });
			await slow;
			const reads = providers.claude.readsOf.get('B');
			const after = await collectState({ providers, now: T + MIN + 1000 });
			const percent = after.providers.claude.accounts.find((account) => account.id === b.id)?.usage
				?.windows[0]?.percent;
			expect(percent).toBe(95);
			expect(providers.claude.readsOf.get('B')).toBe(reads);
		});
	});
});
