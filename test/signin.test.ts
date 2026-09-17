import { describe, expect, test } from 'bun:test';
import { collectState } from '../src/core/collect.ts';
import { signInAgain } from '../src/core/enroll.ts';
import { ServiceError } from '../src/core/errors.ts';
import { accountsFor, loadRegistry, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import type { AccountRecord, UsageSnapshot } from '../src/core/types.ts';
import { loadCredential, storeCredential } from '../src/core/vault.ts';
import { loginArgs } from '../src/providers/claude/login.ts';
import { cred, type FakeProvider, fakeProviders, tokenOf } from './fake-provider.ts';
import { withHome } from './helpers.ts';

const T = Date.parse('2026-09-16T12:00:00Z');

function reading(percent: number): UsageSnapshot {
	return {
		fetchedAt: new Date(T).toISOString(),
		windows: [
			{
				key: 'seven_day',
				label: 'week',
				percent,
				resetsAt: new Date(T + 86_400_000).toISOString(),
			},
		],
	};
}

async function world(): Promise<{
	providers: { claude: FakeProvider; codex: FakeProvider };
	a: AccountRecord;
	b: AccountRecord;
}> {
	const providers = fakeProviders();
	const a = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
	);
	const b = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
	);
	await storeCredential(a, cred('A'));
	await storeCredential(b, cred('B-dead'));
	providers.claude.identities.set('A', { email: 'a@example.com' });
	providers.claude.readings.set('A', () => reading(20));
	providers.claude.installed = cred('A');
	// b's saved login has been refused: the service will not refresh it.
	providers.claude.refreshFailures.set(
		'B-dead',
		new ServiceError('token refresh failed with 400 invalid_grant', 400),
	);
	return { providers, a, b };
}

describe('signing in to an account again', () => {
	test('replaces the login that stopped working, and the account reads again at once', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const before = await collectState({ providers, now: T });
			expect(before.providers.claude.accounts.find((x) => x.id === b.id)?.usage?.error).toContain(
				'no longer works',
			);

			providers.claude.identities.set('B-new', { email: 'b@example.com', plan: 'max' });
			providers.claude.readings.set('B-new', () => reading(40));
			let asked: string | undefined;
			const result = await signInAgain({
				providerId: 'claude',
				account: b,
				providers,
				now: T + 1000,
				login: async (email) => {
					asked = email;
					return cred('B-new');
				},
			});

			expect(asked).toBe('b@example.com');
			expect(result).toEqual({ signedInAs: 'b@example.com', matched: true, slot: b.slot });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B-new');
			const after = await collectState({ providers, now: T + 2000 });
			const usage = after.providers.claude.accounts.find((x) => x.id === b.id)?.usage;
			expect(usage?.error).toBeUndefined();
			expect(usage?.windows[0]?.percent).toBe(40);
		});
	});

	test('signing in as someone else saves that account and leaves the one asked about alone', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.identities.set('C', { email: 'c@example.com' });
			providers.claude.readings.set('C', () => reading(5));
			const result = await signInAgain({
				providerId: 'claude',
				account: b,
				providers,
				now: T,
				login: async () => cred('C'),
			});
			const saved = accountsFor(await loadRegistry(), 'claude').find(
				(x) => x.email === 'c@example.com',
			);
			expect(result).toEqual({
				signedInAs: 'c@example.com',
				matched: false,
				slot: saved?.slot ?? 0,
			});
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B-dead');
			expect(tokenOf((await loadCredential(saved ?? { id: '' })) ?? {})).toBe('C');
		});
	});

	test('a sign-in that is abandoned changes nothing', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await expect(
				signInAgain({
					providerId: 'claude',
					account: b,
					providers,
					login: async () => {
						throw new Error('the Claude sign-in ended with status 1');
					},
				}),
			).rejects.toThrow(/sign-in ended/);
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B-dead');
		});
	});
});

describe('the Claude sign-in command', () => {
	test('asks for a subscription sign-in with the address filled in', () => {
		expect(loginArgs('b@example.com')).toEqual([
			'auth',
			'login',
			'--claudeai',
			'--email',
			'b@example.com',
		]);
		expect(loginArgs()).toEqual(['auth', 'login', '--claudeai']);
	});
});
