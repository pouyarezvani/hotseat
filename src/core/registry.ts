import { randomUUID } from 'node:crypto';
import { acquireLock, readJson, writeJsonAtomic } from './fs.ts';
import { hotseatHome, registryPath } from './paths.ts';
import type { AccountRecord, ProviderId, Registry } from './types.ts';

const EMPTY: Registry = { version: 1, accounts: [], active: {} };

export async function loadRegistry(): Promise<Registry> {
	return (await readJson<Registry>(registryPath())) ?? structuredClone(EMPTY);
}

export async function updateRegistry<T>(
	mutate: (registry: Registry) => T | Promise<T>,
): Promise<T> {
	const lock = await acquireLock(hotseatHome());
	try {
		const registry = await loadRegistry();
		const result = await mutate(registry);
		await writeJsonAtomic(registryPath(), registry);
		return result;
	} finally {
		await lock.release();
	}
}

export function accountsFor(registry: Registry, provider: ProviderId): AccountRecord[] {
	return registry.accounts
		.filter((account) => account.provider === provider)
		.sort((a, b) => a.slot - b.slot);
}

export function findAccount(
	registry: Registry,
	provider: ProviderId,
	selector: string,
): AccountRecord | undefined {
	const candidates = accountsFor(registry, provider);
	const asSlot = Number.parseInt(selector, 10);
	if (String(asSlot) === selector) return candidates.find((account) => account.slot === asSlot);
	const needle = selector.toLowerCase();
	return (
		candidates.find((account) => account.email.toLowerCase() === needle) ??
		candidates.find((account) => account.alias?.toLowerCase() === needle) ??
		candidates.find((account) => account.id === selector) ??
		candidates.find((account) => account.email.toLowerCase().startsWith(needle))
	);
}

export function upsertAccount(
	registry: Registry,
	input: { provider: ProviderId; email: string; plan?: string; slot?: number },
): AccountRecord {
	const existing = registry.accounts.find(
		(account) =>
			account.provider === input.provider &&
			account.email.toLowerCase() === input.email.toLowerCase(),
	);
	if (existing) {
		if (input.plan) existing.plan = input.plan;
		return existing;
	}
	const siblings = accountsFor(registry, input.provider);
	const taken = new Set(siblings.map((account) => account.slot));
	let slot = input.slot ?? 1;
	while (taken.has(slot)) slot += 1;
	const account: AccountRecord = {
		id: randomUUID(),
		provider: input.provider,
		email: input.email,
		slot,
		disabled: false,
		addedAt: new Date().toISOString(),
		...(input.plan ? { plan: input.plan } : {}),
	};
	registry.accounts.push(account);
	return account;
}

export function removeAccount(registry: Registry, id: string): AccountRecord | undefined {
	const index = registry.accounts.findIndex((account) => account.id === id);
	if (index < 0) return undefined;
	const [removed] = registry.accounts.splice(index, 1);
	if (!removed) return undefined;
	if (registry.active[removed.provider] === id) delete registry.active[removed.provider];
	return removed;
}
