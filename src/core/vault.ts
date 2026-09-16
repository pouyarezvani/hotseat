import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fs.ts';
import { vaultDir } from './paths.ts';
import type { AccountRecord, Credential } from './types.ts';

/**
 * Credentials are stored per account under the account's own id, so renaming an
 * email or moving a slot never orphans a stored login.
 */
function credentialPath(account: Pick<AccountRecord, 'id'>): string {
	return join(vaultDir(), `${account.id}.json`);
}

export async function storeCredential(
	account: Pick<AccountRecord, 'id'>,
	credential: Credential,
): Promise<void> {
	await writeJsonAtomic(credentialPath(account), credential, 0o600);
}

export async function loadCredential(
	account: Pick<AccountRecord, 'id'>,
): Promise<Credential | null> {
	return readJson<Credential>(credentialPath(account));
}

export async function dropCredential(account: Pick<AccountRecord, 'id'>): Promise<void> {
	await rm(credentialPath(account), { force: true });
}
