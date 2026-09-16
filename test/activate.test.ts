import { describe, expect, test } from 'bun:test';
import { tick } from '../src/core/auto.ts';
import { readHistory } from '../src/core/history.ts';
import { accountsFor, loadRegistry, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { activate } from '../src/core/switch.ts';
import type { AccountRecord, UsageSnapshot } from '../src/core/types.ts';
import { loadCredential, storeCredential } from '../src/core/vault.ts';
import { cred, type FakeProvider, fakeProviders, tokenOf } from './fake-provider.ts';
import { withHome } from './helpers.ts';

const T = Date.parse('2026-09-16T12:00:00Z');

function reading(percent: number, resetsInHours = 24): UsageSnapshot {
	return {
		fetchedAt: new Date(T).toISOString(),
		windows: [
			{
				key: 'five_hour',
				label: '5h',
				percent: 1,
				resetsAt: new Date(T + 3_600_000).toISOString(),
			},
			{
				key: 'seven_day',
				label: 'week',
				percent,
				resetsAt: new Date(T + resetsInHours * 3_600_000).toISOString(),
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
	claude.identities.set('A', { email: 'a@example.com' });
	claude.identities.set('B', { email: 'b@example.com' });
	claude.readings.set('A', () => reading(50));
	claude.readings.set('B', () => reading(10));
	claude.installed = cred('A');
	return { providers, a, b };
}

describe('switching', () => {
	test('installs the saved login and records which account is in use', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			const result = await activate('claude', b.id, { providers, now: T });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
			expect(result).toMatchObject({
				from: 'a@example.com',
				fromId: a.id,
				to: 'b@example.com',
				alreadyActive: false,
			});
			expect((await loadRegistry()).active.claude).toBe(b.id);
		});
	});

	test('switching to the account already in use changes nothing', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			// The agent rotated its token since the vault copy was saved.
			providers.claude.installed = cred('A-rotated');
			providers.claude.identities.set('A-rotated', { email: 'a@example.com' });
			const result = await activate('claude', a.id, { providers, now: T });
			expect(result.alreadyActive).toBe(true);
			expect(providers.claude.calls.write).toBe(0);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A-rotated');
		});
	});

	test('the outgoing login is saved under the account it belongs to, not the one last recorded', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			// Signed in to B by hand; hotseat still thinks A is in use.
			providers.claude.installed = cred('B-newer');
			providers.claude.identities.set('B-newer', { email: 'b@example.com' });
			const result = await activate('claude', a.id, { providers, now: T });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B-newer');
			expect(result.from).toBe('b@example.com');
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('a login in use that belongs to no saved account is kept as a new account first', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.installed = cred('C');
			providers.claude.identities.set('C', { email: 'c@example.com', plan: 'pro' });
			const result = await activate('claude', b.id, { providers, now: T });
			const saved = accountsFor(await loadRegistry(), 'claude').find(
				(account) => account.email === 'c@example.com',
			);
			expect(saved).toBeDefined();
			expect(tokenOf((await loadCredential(saved ?? { id: '' })) ?? {})).toBe('C');
			expect(result.savedLogin).toEqual({ email: 'c@example.com', slot: saved?.slot ?? 0 });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});

	test('a token refreshed during the switch is saved before it is installed', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.rotate = '+';
			await activate('claude', b.id, { providers, now: T });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B+');
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B+');
		});
	});
});

describe('switching automatically', () => {
	test('moves off an account that reached the limit, to the one that resets soonest with room', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await storeCredential(c, cred('C'));
			providers.claude.identities.set('C', { email: 'c@example.com' });
			providers.claude.readings.set('A', () => reading(95));
			providers.claude.readings.set('B', () => reading(40, 120));
			providers.claude.readings.set('C', () => reading(60, 6));
			const reports = await tick({ providers, now: T });
			expect(reports).toEqual([
				expect.objectContaining({ provider: 'claude', outcome: 'switched', to: 'c@example.com' }),
			]);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('C');
			expect((await readHistory())[0]).toMatchObject({
				reason: 'auto',
				to: 'c@example.com',
				leftAtPercent: 95,
			});
			expect(b.id).toBeDefined();
		});
	});

	test('holds while the account in use is under the limit', async () => {
		await withHome(async () => {
			const { providers } = await world();
			const reports = await tick({ providers, now: T });
			expect(reports[0]?.outcome).toBe('holding');
			expect(reports[0]?.detail).toBe('at 50%, below the 90% limit');
			expect(providers.claude.calls.write).toBe(0);
		});
	});

	test('a login that fails to read three times in a row is switched away from', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await tick({ providers, now: T });
			providers.claude.readings.delete('A');
			const step = 4 * 60_000;
			const outcomes: string[] = [];
			for (let n = 1; n <= 3; n += 1) {
				const [report] = await tick({ providers, now: T + n * step });
				outcomes.push(report?.outcome ?? '');
			}
			expect(outcomes).toEqual(['holding', 'holding', 'switched']);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});

	test('a cached failure seen again before the next read does not count twice', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await tick({ providers, now: T });
			providers.claude.readings.delete('A');
			const outcomes: string[] = [];
			for (let n = 1; n <= 3; n += 1) {
				const [report] = await tick({ providers, now: T + 4 * 60_000 + n * 1000 });
				outcomes.push(report?.outcome ?? '');
			}
			expect(outcomes).toEqual(['holding', 'holding', 'holding']);
		});
	});
});
