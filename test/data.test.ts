import { describe, expect, test } from 'bun:test';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory, recordSwitch } from '../src/core/history.ts';
import { listMappings, mappingFor, removeMapping, setMapping } from '../src/core/mappings.ts';
import { hotseatHome } from '../src/core/paths.ts';
import {
	accountsFor,
	findAccount,
	loadRegistry,
	updateRegistry,
	upsertAccount,
} from '../src/core/registry.ts';
import {
	exportAccounts,
	importAccounts,
	moveSlot,
	purge,
	swapSlots,
} from '../src/core/transfer.ts';
import { loadCredential, storeCredential } from '../src/core/vault.ts';
import { credential, withHome } from './helpers.ts';

async function add(email: string, provider: 'claude' | 'codex' = 'claude') {
	return updateRegistry((registry) => upsertAccount(registry, { provider, email }));
}

describe('per-folder rules', () => {
	test('a rule applies to the folder it was set on', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await setMapping({
				path: '/tmp/project',
				provider: 'claude',
				accountId: account.id,
				email: account.email,
			});
			expect((await mappingFor('/tmp/project', 'claude'))?.email).toBe('one@example.com');
		});
	});

	test('a rule covers everything beneath the folder', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await setMapping({
				path: '/tmp/project',
				provider: 'claude',
				accountId: account.id,
				email: account.email,
			});
			expect((await mappingFor('/tmp/project/src/deep', 'claude'))?.email).toBe('one@example.com');
		});
	});

	test('the nearest rule wins over one further up', async () => {
		await withHome(async () => {
			const outer = await add('outer@example.com');
			const inner = await add('inner@example.com');
			await setMapping({
				path: '/tmp/project',
				provider: 'claude',
				accountId: outer.id,
				email: outer.email,
			});
			await setMapping({
				path: '/tmp/project/api',
				provider: 'claude',
				accountId: inner.id,
				email: inner.email,
			});
			expect((await mappingFor('/tmp/project/api/src', 'claude'))?.email).toBe('inner@example.com');
		});
	});

	test('a rule for one service does not answer for the other', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await setMapping({
				path: '/tmp/project',
				provider: 'claude',
				accountId: account.id,
				email: account.email,
			});
			expect(await mappingFor('/tmp/project', 'codex')).toBeUndefined();
		});
	});

	test('setting a rule twice on one folder replaces it rather than stacking', async () => {
		await withHome(async () => {
			const first = await add('one@example.com');
			const second = await add('two@example.com');
			await setMapping({
				path: '/tmp/project',
				provider: 'claude',
				accountId: first.id,
				email: first.email,
			});
			await setMapping({
				path: '/tmp/project',
				provider: 'claude',
				accountId: second.id,
				email: second.email,
			});
			expect(await listMappings()).toHaveLength(1);
			expect((await mappingFor('/tmp/project', 'claude'))?.email).toBe('two@example.com');
		});
	});

	test('removing a rule reports how many it removed', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await setMapping({
				path: '/tmp/project',
				provider: 'claude',
				accountId: account.id,
				email: account.email,
			});
			expect(await removeMapping('/tmp/project')).toBe(1);
			expect(await removeMapping('/tmp/project')).toBe(0);
			expect(await mappingFor('/tmp/project', 'claude')).toBeUndefined();
		});
	});

	test('an unmapped folder has no rule', async () => {
		await withHome(async () => {
			expect(await mappingFor('/tmp/elsewhere', 'claude')).toBeUndefined();
		});
	});
});

describe('account order', () => {
	test('moving to a free number just takes it', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await moveSlot('claude', account.id, 7);
			expect(accountsFor(await loadRegistry(), 'claude')[0]?.slot).toBe(7);
		});
	});

	test('moving onto a taken number trades places rather than colliding', async () => {
		await withHome(async () => {
			await add('one@example.com');
			const second = await add('two@example.com');
			await moveSlot('claude', second.id, 1);
			const byEmail = new Map(
				accountsFor(await loadRegistry(), 'claude').map((entry) => [entry.email, entry.slot]),
			);
			expect(byEmail.get('two@example.com')).toBe(1);
			expect(byEmail.get('one@example.com')).toBe(2);
		});
	});

	test('swapping exchanges two numbers', async () => {
		await withHome(async () => {
			const first = await add('one@example.com');
			const second = await add('two@example.com');
			await swapSlots('claude', first.id, second.id);
			const byEmail = new Map(
				accountsFor(await loadRegistry(), 'claude').map((entry) => [entry.email, entry.slot]),
			);
			expect(byEmail.get('one@example.com')).toBe(2);
			expect(byEmail.get('two@example.com')).toBe(1);
		});
	});

	test('swapping across services is refused', async () => {
		await withHome(async () => {
			const claude = await add('one@example.com', 'claude');
			const codex = await add('one@example.com', 'codex');
			expect(swapSlots('claude', claude.id, codex.id)).rejects.toThrow(/same provider/);
		});
	});

	test('numbers stay unique after a move', async () => {
		await withHome(async () => {
			const a = await add('a@example.com');
			await add('b@example.com');
			await add('c@example.com');
			await moveSlot('claude', a.id, 3);
			const slots = accountsFor(await loadRegistry(), 'claude').map((entry) => entry.slot);
			expect(new Set(slots).size).toBe(slots.length);
		});
	});
});

describe('moving between machines', () => {
	test('an export carries every account and its login back in', async () => {
		const file = join(await mkdtemp(join(tmpdir(), 'hotseat-export-')), 'accounts.json');
		await withHome(async () => {
			const account = await add('one@example.com');
			await storeCredential(account, credential('abc'));
			expect(await exportAccounts(file)).toBe(1);
		});
		await withHome(async () => {
			expect(await importAccounts(file)).toBe(1);
			const [imported] = accountsFor(await loadRegistry(), 'claude');
			if (!imported) throw new Error('nothing imported');
			expect(imported.email).toBe('one@example.com');
			expect(await loadCredential(imported)).toEqual(credential('abc'));
		});
	});

	test('an export holds live logins, so it is written owner-only', async () => {
		const file = join(await mkdtemp(join(tmpdir(), 'hotseat-export-')), 'accounts.json');
		await withHome(async () => {
			await storeCredential(await add('one@example.com'), credential('abc'));
			await exportAccounts(file);
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		});
	});

	test('importing twice does not duplicate an account', async () => {
		const file = join(await mkdtemp(join(tmpdir(), 'hotseat-export-')), 'accounts.json');
		await withHome(async () => {
			await storeCredential(await add('one@example.com'), credential('abc'));
			await exportAccounts(file);
		});
		await withHome(async () => {
			await importAccounts(file);
			await importAccounts(file);
			expect((await loadRegistry()).accounts).toHaveLength(1);
		});
	});

	test('importing something that is not an export is refused', async () => {
		const file = join(await mkdtemp(join(tmpdir(), 'hotseat-export-')), 'junk.json');
		await Bun.write(file, JSON.stringify({ hello: 'world' }));
		await withHome(async () => {
			expect(importAccounts(file)).rejects.toThrow(/not a hotseat export/);
		});
	});
});

describe('history', () => {
	test('a switch is recorded and read back newest first', async () => {
		await withHome(async () => {
			await recordSwitch({
				at: '2026-09-16T10:00:00Z',
				provider: 'claude',
				to: 'first@example.com',
				reason: 'manual',
			});
			await recordSwitch({
				at: '2026-09-16T11:00:00Z',
				provider: 'claude',
				to: 'second@example.com',
				reason: 'auto',
			});
			const entries = await readHistory();
			expect(entries[0]?.to).toBe('second@example.com');
			expect(entries[1]?.to).toBe('first@example.com');
		});
	});

	test('the limit caps how many come back', async () => {
		await withHome(async () => {
			for (let index = 0; index < 8; index += 1) {
				await recordSwitch({
					at: new Date(index).toISOString(),
					provider: 'claude',
					to: `a${index}@x.com`,
					reason: 'auto',
				});
			}
			expect(await readHistory(3)).toHaveLength(3);
		});
	});

	test('no history yet reads as empty, not an error', async () => {
		await withHome(async () => {
			expect(await readHistory()).toEqual([]);
		});
	});

	test('a torn final line is skipped rather than losing the whole log', async () => {
		await withHome(async (home) => {
			await recordSwitch({
				at: '2026-09-16T10:00:00Z',
				provider: 'claude',
				to: 'good@example.com',
				reason: 'manual',
			});
			await Bun.write(
				join(home, 'history.jsonl'),
				`${await Bun.file(join(home, 'history.jsonl')).text()}{"at":"broken`,
			);
			const entries = await readHistory();
			expect(entries).toHaveLength(1);
			expect(entries[0]?.to).toBe('good@example.com');
		});
	});

	test('what an account was at when it was left is kept', async () => {
		await withHome(async () => {
			await recordSwitch({
				at: '2026-09-16T10:00:00Z',
				provider: 'claude',
				from: 'old@example.com',
				to: 'new@example.com',
				reason: 'auto',
				leftAtPercent: 93,
			});
			expect((await readHistory())[0]?.leftAtPercent).toBe(93);
		});
	});
});

describe('purge', () => {
	test('removes everything hotseat stores', async () => {
		await withHome(async () => {
			await storeCredential(await add('one@example.com'), credential('abc'));
			await recordSwitch({
				at: '2026-09-16T10:00:00Z',
				provider: 'claude',
				to: 'one@example.com',
				reason: 'manual',
			});
			const home = hotseatHome();
			await purge();
			expect(await Bun.file(join(home, 'accounts.json')).exists()).toBe(false);
			expect(await Bun.file(join(home, 'history.jsonl')).exists()).toBe(false);
			expect((await loadRegistry()).accounts).toEqual([]);
		});
	});
});

describe('naming an account', () => {
	test('a prefix that fits two accounts is refused rather than guessed', async () => {
		await withHome(async () => {
			await add('alice@example.com');
			await add('adam@example.com');
			const registry = await loadRegistry();
			expect(() => findAccount(registry, 'claude', 'a')).toThrow(
				/could be alice@example.com or adam@example.com/,
			);
			expect(findAccount(registry, 'claude', 'al')?.email).toBe('alice@example.com');
		});
	});

	test('an exact address wins over a longer one it prefixes', async () => {
		await withHome(async () => {
			await add('a@example.com');
			await add('a@example.com.au');
			expect(findAccount(await loadRegistry(), 'claude', 'a@example.com')?.email).toBe(
				'a@example.com',
			);
		});
	});
});

describe('importing', () => {
	test('an entry that is not an account is refused before anything is written', async () => {
		await withHome(async () => {
			const file = join(await mkdtemp(join(tmpdir(), 'hotseat-export-')), 'accounts.json');
			await Bun.write(
				file,
				JSON.stringify({
					version: 1,
					exportedAt: 'x',
					accounts: [{ provider: 'claude', email: 'x@example.com' }],
				}),
			);
			await expect(importAccounts(file)).rejects.toThrow(/not a hotseat account/);
			expect((await loadRegistry()).accounts).toEqual([]);
		});
	});
});
