import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialFromToken } from '../providers/claude/index.ts';
import { acquireLock, readJson, writeJsonAtomic } from './fs.ts';
import { hotseatHome, registryPath, vaultDir } from './paths.ts';
import {
	type AccountRecord,
	type Credential,
	PROVIDER_IDS,
	type ProviderId,
	type Registry,
} from './types.ts';

/**
 * accounts.json is the one place accounts and their logins live, and it is
 * meant to be edited by hand: an entry needs only a service and an email to
 * be an account, and a Claude entry may give its login as a setup token
 * string. Whatever else is missing is filled in here and written back, so
 * the file always shows the whole truth.
 */

const EMPTY: Registry = { version: 1, accounts: [], active: {}, unreadable: [] };

function isProvider(value: unknown): value is ProviderId {
	return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** A hand-written login: a setup token string for Claude, or a whole credential. */
function readLogin(raw: unknown, provider: ProviderId): Credential | undefined {
	if (typeof raw === 'string' && raw.trim().length > 0) {
		return provider === 'claude' ? credentialFromToken(raw.trim()) : undefined;
	}
	return asObject(raw);
}

/**
 * Turns one entry from the file into an account, filling in what a person
 * would not write. Returns nothing for an entry that is not an account at
 * all, and says whether anything had to be filled in.
 */
function readEntry(
	raw: unknown,
	takenSlots: Set<number>,
): { record: AccountRecord; changed: boolean } | undefined {
	const entry = asObject(raw);
	if (!entry || !isProvider(entry.provider)) return undefined;
	if (typeof entry.email !== 'string' || entry.email.trim().length === 0) return undefined;
	let changed = false;
	const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : randomUUID();
	if (id !== entry.id) changed = true;
	let slot =
		Number.isInteger(entry.slot) && (entry.slot as number) > 0 ? (entry.slot as number) : 1;
	while (takenSlots.has(slot)) slot += 1;
	if (slot !== entry.slot) changed = true;
	takenSlots.add(slot);
	const disabled = entry.disabled === true;
	if (disabled !== entry.disabled) changed = true;
	const addedAt = typeof entry.addedAt === 'string' ? entry.addedAt : new Date().toISOString();
	if (addedAt !== entry.addedAt) changed = true;
	const login = readLogin(entry.login, entry.provider);
	if (typeof entry.login === 'string' && login) changed = true;
	if (entry.login !== undefined && !login) changed = true;
	const record: AccountRecord = {
		id,
		provider: entry.provider,
		email: entry.email.trim(),
		slot,
		disabled,
		addedAt,
		...(typeof entry.alias === 'string' && entry.alias.length > 0 ? { alias: entry.alias } : {}),
		...(typeof entry.plan === 'string' && entry.plan.length > 0 ? { plan: entry.plan } : {}),
		...(typeof entry.lastActivatedAt === 'string'
			? { lastActivatedAt: entry.lastActivatedAt }
			: {}),
		...(login ? { login } : {}),
	};
	return { record, changed };
}

function readRegistry(raw: unknown): { registry: Registry; changed: boolean } {
	const file = asObject(raw);
	if (!file || !Array.isArray(file.accounts))
		return { registry: structuredClone(EMPTY), changed: false };
	let changed = false;
	const accounts: AccountRecord[] = [];
	const unreadable: unknown[] = [];
	const slots: Partial<Record<ProviderId, Set<number>>> = {};
	for (const entry of file.accounts) {
		const provider = asObject(entry)?.provider;
		let taken = new Set<number>();
		if (isProvider(provider)) {
			taken = slots[provider] ?? new Set<number>();
			slots[provider] = taken;
		}
		const read = readEntry(entry, taken);
		if (!read) {
			unreadable.push(entry);
			continue;
		}
		accounts.push(read.record);
		if (read.changed) changed = true;
	}
	const active: Registry['active'] = {};
	const rawActive = asObject(file.active) ?? {};
	for (const provider of PROVIDER_IDS) {
		const id = rawActive[provider];
		// A pointer at an entry that was deleted by hand points at nothing.
		if (typeof id === 'string' && accounts.some((account) => account.id === id))
			active[provider] = id;
		else if (id !== undefined) changed = true;
	}
	return { registry: { version: 1, accounts, active, unreadable }, changed };
}

/** What goes on disk: the accounts, then any entries that could not be read, untouched. */
function serialize(registry: Registry): unknown {
	return {
		version: 1,
		accounts: [...registry.accounts, ...registry.unreadable],
		active: registry.active,
	};
}

async function readFromDisk(): Promise<{ registry: Registry; changed: boolean }> {
	return readRegistry(await readJson<unknown>(registryPath()));
}

export async function loadRegistry(): Promise<Registry> {
	const first = await readFromDisk();
	if (!first.changed) return first.registry;
	// Something hand-written needed filling in. Write it back at once, under
	// the lock, so the ids and numbers it was given stay the same next time.
	const lock = await acquireLock(hotseatHome());
	try {
		const again = await readFromDisk();
		if (again.changed) await writeJsonAtomic(registryPath(), serialize(again.registry), 0o600);
		return again.registry;
	} finally {
		await lock.release();
	}
}

export async function updateRegistry<T>(
	mutate: (registry: Registry) => T | Promise<T>,
): Promise<T> {
	const lock = await acquireLock(hotseatHome());
	try {
		const { registry } = await readFromDisk();
		const result = await mutate(registry);
		await writeJsonAtomic(registryPath(), serialize(registry), 0o600);
		return result;
	} finally {
		await lock.release();
	}
}

/**
 * Logins used to live one file per account under vault/. They are folded into
 * accounts.json the first time a newer hotseat runs, and the folder removed.
 */
export async function migrateVault(): Promise<number> {
	const dir = vaultDir();
	const files = await readdir(dir).catch(() => [] as string[]);
	const entries = files.filter((name) => name.endsWith('.json'));
	if (entries.length === 0) {
		await rm(dir, { recursive: true, force: true });
		return 0;
	}
	const moved = await updateRegistry(async (registry) => {
		let count = 0;
		for (const name of entries) {
			const account = registry.accounts.find(
				(entry) => entry.id === name.slice(0, -'.json'.length),
			);
			const login = await readJson<Credential>(join(dir, name));
			if (!account || !login) continue;
			account.login = login;
			count += 1;
		}
		return count;
	});
	await rm(dir, { recursive: true, force: true });
	return moved;
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
	const exact =
		candidates.find((account) => account.email.toLowerCase() === needle) ??
		candidates.find((account) => account.alias?.toLowerCase() === needle) ??
		candidates.find((account) => account.id === selector);
	if (exact) return exact;
	const prefixed = candidates.filter((account) => account.email.toLowerCase().startsWith(needle));
	if (prefixed.length > 1) {
		// A short prefix that fits two accounts must not quietly pick one,
		// least of all for a remove.
		throw new Error(
			`"${selector}" could be ${prefixed.map((account) => account.email).join(' or ')} - give more of the address`,
		);
	}
	return prefixed[0];
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

/**
 * Names an account, or unnames it. A name that is only digits would be taken
 * for an account number, and two accounts with one name could not be told
 * apart, so both are refused.
 */
export function setAlias(registry: Registry, id: string, alias: string | undefined): AccountRecord {
	const record = registry.accounts.find((entry) => entry.id === id);
	if (!record) throw new Error('that account is no longer in accounts.json');
	if (alias === undefined || alias.trim().length === 0) {
		delete record.alias;
		return record;
	}
	const name = alias.trim();
	if (/^\d+$/.test(name)) {
		throw new Error(
			`"${name}" is a number, which is how accounts are already picked - choose a name`,
		);
	}
	const taken = registry.accounts.find(
		(entry) =>
			entry.id !== id &&
			entry.provider === record.provider &&
			entry.alias?.toLowerCase() === name.toLowerCase(),
	);
	if (taken) throw new Error(`${taken.email} is already called "${name}"`);
	record.alias = name;
	return record;
}
