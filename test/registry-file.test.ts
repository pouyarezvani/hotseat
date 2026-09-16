import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { collectState } from '../src/core/collect.ts';
import { registryPath, vaultDir } from '../src/core/paths.ts';
import { loadRegistry, migrateVault, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { loadCredential, storeCredential } from '../src/core/vault.ts';
import { cred, fakeProviders } from './fake-provider.ts';
import { credential, withHome } from './helpers.ts';

async function writeFile(entries: unknown[], active: Record<string, string> = {}): Promise<void> {
	await mkdir(join(registryPath(), '..'), { recursive: true });
	await Bun.write(registryPath(), JSON.stringify({ version: 1, accounts: entries, active }));
}

async function fileOnDisk(): Promise<{ accounts: unknown[]; active: Record<string, string> }> {
	return JSON.parse(await Bun.file(registryPath()).text());
}

function entry(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

describe('accounts.json edited by hand', () => {
	test('an entry with just a service and an email becomes an account, and the file is completed', async () => {
		await withHome(async () => {
			await writeFile([{ provider: 'claude', email: 'hand@example.com' }]);
			const [account] = (await loadRegistry()).accounts;
			expect(account).toMatchObject({
				provider: 'claude',
				email: 'hand@example.com',
				slot: 1,
				disabled: false,
			});
			expect(account?.id).toMatch(/^[0-9a-f-]{36}$/);
			const written = entry((await fileOnDisk()).accounts[0]);
			expect(written.id).toBe(account?.id);
			expect(typeof written.addedAt).toBe('string');
			// Read again: the same id, not a fresh one each time.
			expect((await loadRegistry()).accounts[0]?.id).toBe(account?.id);
		});
	});

	test('a Claude login pasted as a setup token becomes a saved login', async () => {
		await withHome(async () => {
			await writeFile([
				{ provider: 'claude', email: 'hand@example.com', login: 'sk-ant-oat01-abc' },
			]);
			const [account] = (await loadRegistry()).accounts;
			const login = await loadCredential(account ?? { id: '' });
			expect(login?.claudeAiOauth).toMatchObject({ accessToken: 'sk-ant-oat01-abc' });
			expect(typeof entry((await fileOnDisk()).accounts[0]).login).toBe('object');
		});
	});

	test('a number already taken is moved along rather than shared', async () => {
		await withHome(async () => {
			await writeFile([
				{ provider: 'claude', email: 'one@example.com', slot: 1 },
				{ provider: 'claude', email: 'two@example.com', slot: 1 },
				{ provider: 'codex', email: 'three@example.com', slot: 1 },
			]);
			const slots = (await loadRegistry()).accounts.map(
				(account) => `${account.provider}:${account.slot}`,
			);
			expect(slots).toEqual(['claude:1', 'claude:2', 'codex:1']);
		});
	});

	test('an entry that is not an account is kept exactly as written, and counted', async () => {
		await withHome(async () => {
			await writeFile([{ provider: 'claude', email: 'one@example.com' }, { note: 'todo' }, 'junk']);
			const registry = await loadRegistry();
			expect(registry.accounts).toHaveLength(1);
			expect(registry.unreadable).toEqual([{ note: 'todo' }, 'junk']);
			await updateRegistry((current) =>
				upsertAccount(current, { provider: 'codex', email: 'two@example.com' }),
			);
			const written = (await fileOnDisk()).accounts;
			expect(written).toHaveLength(4);
			expect(written.slice(-2)).toEqual([{ note: 'todo' }, 'junk']);
		});
	});

	test('deleting the account in use by hand clears the pointer at it', async () => {
		await withHome(async () => {
			await writeFile([{ id: 'keep', provider: 'claude', email: 'one@example.com' }], {
				claude: 'gone',
			});
			expect((await loadRegistry()).active).toEqual({});
			expect((await fileOnDisk()).active).toEqual({});
		});
	});

	test('a login lives in the account entry, readable only by its owner', async () => {
		await withHome(async () => {
			const account = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'one@example.com' }),
			);
			await storeCredential(account, credential('abc'));
			expect(entry((await fileOnDisk()).accounts[0]).login).toEqual(credential('abc'));
			expect((await stat(registryPath())).mode & 0o777).toBe(0o600);
		});
	});

	test('a login never reaches the board, the menu or state.json', async () => {
		await withHome(async () => {
			const providers = fakeProviders();
			const account = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'one@example.com' }),
			);
			await storeCredential(account, cred('SECRET-TOKEN'));
			providers.claude.identities.set('SECRET-TOKEN', { email: 'one@example.com' });
			providers.claude.readings.set('SECRET-TOKEN', () => ({ fetchedAt: 'x', windows: [] }));
			const state = await collectState({ providers });
			expect(JSON.stringify(state)).not.toContain('SECRET-TOKEN');
			expect(JSON.stringify(state)).not.toContain('login');
		});
	});
});

describe('logins saved by an older hotseat', () => {
	test('are folded into accounts.json once, and the old folder removed', async () => {
		await withHome(async () => {
			const account = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'one@example.com' }),
			);
			await mkdir(vaultDir(), { recursive: true });
			await Bun.write(join(vaultDir(), `${account.id}.json`), JSON.stringify(credential('old')));
			await Bun.write(join(vaultDir(), 'orphan.json'), JSON.stringify(credential('orphan')));
			expect(await migrateVault()).toBe(1);
			expect(await loadCredential(account)).toEqual(credential('old'));
			await expect(readdir(vaultDir())).rejects.toThrow();
			expect(await migrateVault()).toBe(0);
		});
	});
});
