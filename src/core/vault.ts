import { loadRegistry, updateRegistry } from './registry.ts';
import type { AccountRecord, Credential } from './types.ts';

/**
 * A login is part of its account's entry in accounts.json. These are the
 * three things anything else needs to do with one.
 */

/**
 * Whatever changes when a login is replaced or its token rotated. The whole
 * credential is hashed rather than one field so no service-specific shape has
 * to be known here.
 */
export function fingerprint(credential: Credential): string {
	return new Bun.CryptoHasher('sha256').update(JSON.stringify(credential)).digest('hex');
}

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

/**
 * Saves a login for the account unless `keepSaved` says the login saved at that
 * moment should stay, or the saved login is recorded as the one replacing it.
 * The check runs inside the write, so a copy judged against what was saved
 * earlier can never replace a login saved since. Returns the saved login it
 * kept instead, or null when it saved the new one.
 */
export async function storeCredentialUnless(
	account: Pick<AccountRecord, 'id'>,
	credential: Credential,
	keepSaved: (saved: Credential) => boolean,
): Promise<Credential | null> {
	return updateRegistry((registry) => {
		const record = registry.accounts.find((entry) => entry.id === account.id);
		if (!record) throw new Error('that account is no longer in accounts.json');
		if (
			record.login &&
			(record.renewedFrom === fingerprint(credential) || keepSaved(record.login))
		) {
			return structuredClone(record.login);
		}
		record.login = structuredClone(credential);
		return null;
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
