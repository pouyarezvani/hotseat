import { loadRegistry, updateRegistry } from './registry.ts';
import type { AccountRecord, Credential } from './types.ts';

/**
 * A login is part of its account's entry in accounts.json. These are the
 * three things anything else needs to do with one.
 */

export async function storeCredential(
	account: Pick<AccountRecord, 'id'>,
	credential: Credential,
): Promise<void> {
	await updateRegistry((registry) => {
		const record = registry.accounts.find((entry) => entry.id === account.id);
		if (!record) throw new Error('that account is no longer in accounts.json');
		record.login = structuredClone(credential);
	});
}

export async function loadCredential(
	account: Pick<AccountRecord, 'id'>,
): Promise<Credential | null> {
	const record = (await loadRegistry()).accounts.find((entry) => entry.id === account.id);
	return record?.login ? structuredClone(record.login) : null;
}

export async function dropCredential(account: Pick<AccountRecord, 'id'>): Promise<void> {
	await updateRegistry((registry) => {
		const record = registry.accounts.find((entry) => entry.id === account.id);
		if (record) delete record.login;
	});
}
