import { rm } from 'node:fs/promises';
import { PROVIDERS } from './collect.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { hotseatHome } from './paths.ts';
import { accountsFor, loadRegistry, updateRegistry } from './registry.ts';
import type { AccountRecord, Credential, ProviderId, Registry } from './types.ts';
import { PROVIDER_IDS } from './types.ts';
import { storeCredential } from './vault.ts';

interface Bundle {
	version: 1;
	exportedAt: string;
	/** Accounts as they appear in accounts.json. Older exports carried the login as `credential`. */
	accounts: (AccountRecord & { credential?: Credential | null })[];
}

/**
 * Exports accounts with their logins. The file holds live tokens, so it is
 * written owner-only and the caller is told plainly what it contains.
 */
export async function exportAccounts(path: string): Promise<number> {
	const registry = await loadRegistry();
	const bundle: Bundle = {
		version: 1,
		exportedAt: new Date().toISOString(),
		accounts: registry.accounts,
	};
	await writeJsonAtomic(path, bundle, 0o600);
	return registry.accounts.length;
}

export async function importAccounts(path: string): Promise<number> {
	const bundle = await readJson<Bundle>(path);
	if (bundle?.version !== 1 || !Array.isArray(bundle.accounts)) {
		throw new Error(`${path} is not a hotseat export`);
	}
	let imported = 0;
	for (const entry of bundle.accounts) {
		const { credential, login, ...record } = entry;
		const saved = login ?? credential ?? undefined;
		const shaped =
			typeof record === 'object' &&
			record !== null &&
			(PROVIDER_IDS as readonly string[]).includes(record.provider) &&
			typeof record.email === 'string' &&
			record.email.length > 0 &&
			Number.isInteger(record.slot) &&
			record.slot > 0;
		if (!shaped) throw new Error(`${path} has an account entry that is not a hotseat account`);
		record.disabled = record.disabled === true;
		if (typeof record.addedAt !== 'string') record.addedAt = new Date().toISOString();
		const account = await updateRegistry((registry) => {
			const existing = registry.accounts.find(
				(candidate) =>
					candidate.provider === record.provider &&
					candidate.email.toLowerCase() === record.email.toLowerCase(),
			);
			if (existing) return existing;
			const taken = new Set(accountsFor(registry, record.provider).map((a) => a.slot));
			let slot = record.slot;
			while (taken.has(slot)) slot += 1;
			const created: AccountRecord = { ...record, slot };
			registry.accounts.push(created);
			return created;
		});
		if (saved) await storeCredential(account, saved);
		imported += 1;
	}
	return imported;
}

/** Exchanges two accounts' numbers, so the order matches how you think about them. */
export async function swapSlots(
	provider: ProviderId,
	first: string,
	second: string,
): Promise<void> {
	await updateRegistry((registry) => {
		const a = registry.accounts.find((account) => account.id === first);
		const b = registry.accounts.find((account) => account.id === second);
		if (!a || !b) throw new Error('both accounts must exist');
		if (a.provider !== provider || b.provider !== provider) {
			throw new Error('both accounts must belong to the same provider');
		}
		[a.slot, b.slot] = [b.slot, a.slot];
	});
}

/** Moves an account to a number, trading places with whoever already holds it. */
export async function moveSlot(
	provider: ProviderId,
	accountId: string,
	slot: number,
): Promise<void> {
	await updateRegistry((registry: Registry) => {
		const account = registry.accounts.find((entry) => entry.id === accountId);
		if (!account) throw new Error('that account does not exist');
		const occupant = registry.accounts.find(
			(entry) => entry.provider === provider && entry.slot === slot && entry.id !== accountId,
		);
		if (occupant) occupant.slot = account.slot;
		account.slot = slot;
	});
}

/** Deletes everything hotseat stores. The agents' own logins are untouched. */
export async function purge(): Promise<string> {
	const home = hotseatHome();
	await rm(home, { recursive: true, force: true });
	return home;
}

export async function providerOf(id: string): Promise<ProviderId> {
	if (id in PROVIDERS) return id as ProviderId;
	throw new Error(`unknown provider "${id}"`);
}
