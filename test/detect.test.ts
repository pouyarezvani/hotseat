import { describe, expect, test } from 'bun:test';
import { detectInstalled } from '../src/core/enroll.ts';
import { accountsFor, loadRegistry, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { setSetting } from '../src/core/settings.ts';
import { holdSwitch } from '../src/core/switch-lock.ts';
import { fakeProviders } from './fake-provider.ts';
import { withHome } from './helpers.ts';

function signedIn(token: string, email: string) {
	const providers = fakeProviders();
	providers.antigravity.installed = { token, issued: 1 };
	providers.antigravity.identities.set(token, { email, plan: 'Google AI Pro' });
	return providers;
}

describe('a service signed in on this Mac with no account saved', () => {
	test('is added by itself, as the account in use, with its plan', async () => {
		await withHome(async () => {
			const providers = signedIn('G1', 'someone@example.com');
			expect(await detectInstalled({ providers })).toEqual([
				{ provider: 'antigravity', email: 'someone@example.com' },
			]);
			const registry = await loadRegistry();
			const [account] = accountsFor(registry, 'antigravity');
			expect(account?.email).toBe('someone@example.com');
			expect(account?.plan).toBe('Google AI Pro');
			expect(registry.active.antigravity).toBe(account?.id);
		});
	});

	test('is added once: the next pass finds its account and asks nothing', async () => {
		await withHome(async () => {
			const providers = signedIn('G1', 'someone@example.com');
			await detectInstalled({ providers });
			const asked = providers.antigravity.calls.identify;
			expect(await detectInstalled({ providers })).toEqual([]);
			expect(providers.antigravity.calls.identify).toBe(asked);
			expect(accountsFor(await loadRegistry(), 'antigravity').length).toBe(1);
		});
	});

	test('a service that is not signed in adds nothing', async () => {
		await withHome(async () => {
			expect(await detectInstalled({ providers: fakeProviders() })).toEqual([]);
			expect((await loadRegistry()).accounts).toEqual([]);
		});
	});

	test('a service that already has an account is left alone, whoever is signed in', async () => {
		await withHome(async () => {
			await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'antigravity', email: 'first@example.com' }),
			);
			const providers = signedIn('G2', 'second@example.com');
			expect(await detectInstalled({ providers })).toEqual([]);
			expect(accountsFor(await loadRegistry(), 'antigravity').map((a) => a.email)).toEqual([
				'first@example.com',
			]);
		});
	});

	test('a service no longer looked for is not added', async () => {
		await withHome(async () => {
			await setSetting('autoDetectProviders', 'claude,codex');
			const providers = signedIn('G1', 'someone@example.com');
			expect(await detectInstalled({ providers })).toEqual([]);
			expect((await loadRegistry()).accounts).toEqual([]);
		});
	});

	test('one that cannot be named right now is left for the next pass, and the others still go in', async () => {
		await withHome(async () => {
			const providers = signedIn('G1', 'someone@example.com');
			providers.claude.installed = { token: 'C1', issued: 1 };
			providers.claude.identifyFails = true;
			expect(await detectInstalled({ providers })).toEqual([
				{ provider: 'antigravity', email: 'someone@example.com' },
			]);
			expect(accountsFor(await loadRegistry(), 'claude')).toEqual([]);
			providers.claude.identifyFails = false;
			providers.claude.identities.set('C1', { email: 'c@example.com' });
			expect(await detectInstalled({ providers })).toEqual([
				{ provider: 'claude', email: 'c@example.com' },
			]);
		});
	});
});

describe('two passes looking at once', () => {
	test('a pass that was slow to name the login does not write over an account saved meanwhile', async () => {
		await withHome(async () => {
			const providers = signedIn('G1', 'someone@example.com');
			providers.antigravity.identifyDelayMs = 40;
			const slow = detectInstalled({ providers });
			// Meanwhile another pass adds the account, already holding a newer login.
			await Bun.sleep(5);
			await updateRegistry((registry) => {
				const record = upsertAccount(registry, {
					provider: 'antigravity',
					email: 'someone@example.com',
				});
				record.login = { token: 'G2', issued: 2 };
			});
			expect(await slow).toEqual([]);
			const [account] = accountsFor(await loadRegistry(), 'antigravity');
			expect(account?.login).toEqual({ token: 'G2', issued: 2 });
		});
	});
});

describe('looking while an account is being removed', () => {
	test('a service turned off while a pass waited is not added: the setting is read again under the lock', async () => {
		await withHome(async () => {
			const providers = signedIn('G1', 'someone@example.com');
			const held = await holdSwitch('antigravity');
			const pass = detectInstalled({ providers });
			await Bun.sleep(20);
			await setSetting('autoDetectProviders', 'claude,codex,grok');
			await held.release();
			expect(await pass).toEqual([]);
			expect(accountsFor(await loadRegistry(), 'antigravity')).toEqual([]);
		});
	});
});
