import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { registryPath } from '../src/core/paths.ts';
import {
	accountsFor,
	findAccount,
	loadRegistry,
	removeAccount,
	updateRegistry,
	upsertAccount,
} from '../src/core/registry.ts';
import { dropCredential, loadCredential, storeCredential } from '../src/core/vault.ts';
import { credential, withHome } from './helpers.ts';

async function add(email: string, provider: 'claude' | 'codex' = 'claude') {
	return updateRegistry((registry) => upsertAccount(registry, { provider, email }));
}

describe('adding accounts', () => {
	test('the first account of a service takes number 1', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			expect(account.slot).toBe(1);
		});
	});

	test('each new account takes the next free number', async () => {
		await withHome(async () => {
			await add('one@example.com');
			await add('two@example.com');
			const third = await add('three@example.com');
			expect(third.slot).toBe(3);
		});
	});

	test('adding the same email twice returns the same account, not a duplicate', async () => {
		await withHome(async () => {
			const first = await add('one@example.com');
			const again = await add('one@example.com');
			expect(again.id).toBe(first.id);
			expect((await loadRegistry()).accounts).toHaveLength(1);
		});
	});

	test('an email that differs only in case is the same account', async () => {
		await withHome(async () => {
			const first = await add('One@Example.com');
			const again = await add('one@example.com');
			expect(again.id).toBe(first.id);
		});
	});

	test('each service numbers its accounts independently', async () => {
		await withHome(async () => {
			await add('one@example.com', 'claude');
			const codex = await add('one@example.com', 'codex');
			expect(codex.slot).toBe(1);
		});
	});

	test('a new account starts enabled', async () => {
		await withHome(async () => {
			expect((await add('one@example.com')).disabled).toBe(false);
		});
	});
});

describe('finding an account', () => {
	test('by number, by email, by name, and by the start of an email', async () => {
		await withHome(async () => {
			await add('alpha@example.com');
			const second = await add('beta@example.com');
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === second.id);
				if (record) record.alias = 'work';
			});
			const registry = await loadRegistry();
			expect(findAccount(registry, 'claude', '2')?.email).toBe('beta@example.com');
			expect(findAccount(registry, 'claude', 'beta@example.com')?.id).toBe(second.id);
			expect(findAccount(registry, 'claude', 'work')?.id).toBe(second.id);
			expect(findAccount(registry, 'claude', 'bet')?.id).toBe(second.id);
		});
	});

	test('a name is matched whatever case it is typed in', async () => {
		await withHome(async () => {
			const account = await add('alpha@example.com');
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === account.id);
				if (record) record.alias = 'Work';
			});
			expect(findAccount(await loadRegistry(), 'claude', 'WORK')?.id).toBe(account.id);
		});
	});

	test('never returns an account belonging to the other service', async () => {
		await withHome(async () => {
			await add('shared@example.com', 'codex');
			expect(findAccount(await loadRegistry(), 'claude', 'shared@example.com')).toBeUndefined();
		});
	});

	test('returns nothing for a number no account holds', async () => {
		await withHome(async () => {
			await add('one@example.com');
			expect(findAccount(await loadRegistry(), 'claude', '9')).toBeUndefined();
		});
	});
});

describe('removing an account', () => {
	test('takes it off the list and clears it from being in use', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await updateRegistry((registry) => {
				registry.active.claude = account.id;
			});
			await updateRegistry((registry) => removeAccount(registry, account.id));
			const registry = await loadRegistry();
			expect(registry.accounts).toHaveLength(0);
			expect(registry.active.claude).toBeUndefined();
		});
	});

	test('leaves another account in use untouched', async () => {
		await withHome(async () => {
			const keep = await add('keep@example.com');
			const drop = await add('drop@example.com');
			await updateRegistry((registry) => {
				registry.active.claude = keep.id;
			});
			await updateRegistry((registry) => removeAccount(registry, drop.id));
			expect((await loadRegistry()).active.claude).toBe(keep.id);
		});
	});

	test('removing one that does not exist changes nothing', async () => {
		await withHome(async () => {
			await add('one@example.com');
			await updateRegistry((registry) => removeAccount(registry, 'nope'));
			expect((await loadRegistry()).accounts).toHaveLength(1);
		});
	});
});

describe('saved logins', () => {
	test('a login round-trips exactly', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await storeCredential(account, credential('abc'));
			const loaded = await loadCredential(account);
			expect(loaded).toEqual(credential('abc'));
		});
	});

	test('a saved login is readable only by its owner', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await storeCredential(account, credential('abc'));
			const mode = (await stat(registryPath())).mode & 0o777;
			expect(mode).toBe(0o600);
		});
	});

	test('accounts do not share a login', async () => {
		await withHome(async () => {
			const first = await add('one@example.com');
			const second = await add('two@example.com');
			await storeCredential(first, credential('first'));
			await storeCredential(second, credential('second'));
			expect(await loadCredential(first)).toEqual(credential('first'));
			expect(await loadCredential(second)).toEqual(credential('second'));
		});
	});

	test('an account with no saved login reads as nothing, not an error', async () => {
		await withHome(async () => {
			expect(await loadCredential(await add('one@example.com'))).toBeNull();
		});
	});

	test('dropping a login removes it and is safe to repeat', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await storeCredential(account, credential('abc'));
			await dropCredential(account);
			await dropCredential(account);
			expect(await loadCredential(account)).toBeNull();
		});
	});

	test('a login is keyed by the account, so renaming its email keeps it', async () => {
		await withHome(async () => {
			const account = await add('one@example.com');
			await storeCredential(account, credential('abc'));
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === account.id);
				if (record) record.email = 'renamed@example.com';
			});
			expect(await loadCredential(account)).toEqual(credential('abc'));
		});
	});
});

describe('ordering', () => {
	test('accounts come back in number order regardless of when they were added', async () => {
		await withHome(async () => {
			const first = await add('one@example.com');
			const second = await add('two@example.com');
			await updateRegistry((registry) => {
				const a = registry.accounts.find((entry) => entry.id === first.id);
				const b = registry.accounts.find((entry) => entry.id === second.id);
				if (a && b) {
					a.slot = 5;
					b.slot = 2;
				}
			});
			const order = accountsFor(await loadRegistry(), 'claude').map((entry) => entry.email);
			expect(order).toEqual(['two@example.com', 'one@example.com']);
		});
	});
});
