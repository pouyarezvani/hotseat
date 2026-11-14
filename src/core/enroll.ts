import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFromToken } from '../providers/claude/index.ts';
import { oauthOf } from '../providers/claude/keychain.ts';
import { loginIsolated } from '../providers/claude/login.ts';
import { loginIn } from '../providers/grok/index.ts';
import { agentCommand } from './agent-command.ts';
import { collectState, forgetReading, liveIdentity, loadCache, PROVIDERS } from './collect.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { cleanUpEvenIfInterrupted } from './interrupt.ts';
import { statePath } from './paths.ts';
import { accountsFor, loadRegistry, updateRegistry, upsertAccount } from './registry.ts';
import { putInUse } from './renew.ts';
import { loadSettings } from './settings.ts';
import { holdSwitch } from './switch-lock.ts';
import {
	type AccountRecord,
	type Credential,
	type Identity,
	PROVIDER_IDS,
	type Provider,
	type ProviderId,
} from './types.ts';
import { fingerprint } from './vault.ts';

/** Saves a credential under the account it belongs to, creating it if new. */
export async function enroll(
	providerId: ProviderId,
	credential: Credential,
	fallbackEmail?: string,
	options: { providers?: Record<ProviderId, Provider>; now?: number } = {},
): Promise<AccountRecord> {
	const provider = (options.providers ?? PROVIDERS)[providerId];
	const identity = await provider.identify(credential).catch(() => null);
	const email = identity?.email ?? fallbackEmail;
	if (!email) {
		throw new Error('could not tell which account this login belongs to');
	}
	const account = await saveLogin(providerId, identity ?? { email }, credential);
	// Whatever was read, or failed, with the old login no longer applies.
	await forgetReading(account.id);
	// Publish the new picture immediately so the menu bar reflects the account
	// as soon as it exists, rather than at its next scheduled read.
	await publishState({ force: true, ...options });
	return account;
}

/**
 * Saves a login under the account it signs in to, adding that account if it
 * is new. A login about to go in use is saved with the installed login it
 * replaces, so that login can be named as this account's until it is.
 */
async function saveLogin(
	providerId: ProviderId,
	identity: Identity,
	credential: Credential,
	replacing?: Credential,
): Promise<AccountRecord> {
	return updateRegistry((registry) => {
		const record = upsertAccount(registry, {
			provider: providerId,
			email: identity.email,
			...(identity.plan ? { plan: identity.plan } : {}),
		});
		record.login = structuredClone(credential);
		if (replacing) record.renewedFrom = fingerprint(replacing);
		const { login: _login, ...rest } = record;
		return rest;
	});
}

/**
 * Saves the login this machine is signed in to as its account's, and makes
 * that account the one in use, or returns nothing when no login is signed in.
 */
export async function saveInstalled(
	providerId: ProviderId,
	options: {
		providers?: Record<ProviderId, Provider>;
		/** Save only while the service still has no account, decided as the save is made. */
		onlyIfNone?: boolean;
	} = {},
): Promise<{ account: AccountRecord; email: string } | null> {
	const provider = (options.providers ?? PROVIDERS)[providerId];
	const credential = await provider.readAgentCredential();
	if (!credential) return null;
	const identity = await provider.identify(credential);
	const account = await updateRegistry((registry) => {
		// Naming the login took a request, and another pass may have added or
		// renewed this service's account meanwhile. What it saved is newer
		// than the login read before the request, so it is left alone.
		if (options.onlyIfNone && registry.accounts.some((entry) => entry.provider === providerId)) {
			return null;
		}
		const record = upsertAccount(registry, {
			provider: providerId,
			email: identity.email,
			...(identity.plan ? { plan: identity.plan } : {}),
		});
		record.login = structuredClone(credential);
		record.inUseFrom = fingerprint(credential);
		registry.active[providerId] = record.id;
		const { login: _login, ...rest } = record;
		return rest;
	});
	return account ? { account, email: identity.email } : null;
}

/**
 * Adds the account each service is signed in to on this Mac, for a service
 * that has none saved and is still looked for. So a service appears on its own
 * once it is installed and signed in, with nothing to run. One that cannot be
 * read or named right now is left for the next pass.
 */
export async function detectInstalled(
	options: { providers?: Record<ProviderId, Provider> } = {},
): Promise<{ provider: ProviderId; email: string }[]> {
	const wanted = (await loadSettings()).autoDetectProviders;
	const registry = await loadRegistry();
	const found: { provider: ProviderId; email: string }[] = [];
	for (const provider of PROVIDER_IDS) {
		if (!wanted.includes(provider)) continue;
		if (registry.accounts.some((account) => account.provider === provider)) continue;
		// Under the switch lock, which removing an account also holds, and with
		// the setting read again there: an account removed meanwhile, with the
		// service no longer looked for, is not added straight back.
		const held = await holdSwitch(provider);
		const saved = await (async () => {
			try {
				if (!(await loadSettings()).autoDetectProviders.includes(provider)) return null;
				return await saveInstalled(provider, { ...options, onlyIfNone: true });
			} catch {
				return null;
			} finally {
				await held.release();
			}
		})();
		if (saved) found.push({ provider, email: saved.email });
	}
	return found;
}

/**
 * Signs in to an account again through the browser, as adding it did, and
 * puts the new login in place of the one that stopped working. The sign-in
 * runs against a scratch folder, so nothing in use is signed out. Whoever
 * actually signed in is who gets saved: signing in as a different account
 * saves that one and leaves the account asked about untouched.
 */
export async function signInAgain(input: {
	providerId: ProviderId;
	account: Pick<AccountRecord, 'id' | 'email' | 'slot'>;
	login?: (email: string) => Promise<Credential>;
	providers?: Record<ProviderId, Provider>;
	now?: number;
}): Promise<{ signedInAs: string; matched: boolean; slot: number }> {
	const login = input.login ?? isolatedLogin(input.providerId);
	const credential = await login(input.account.email);
	const options = {
		...(input.providers ? { providers: input.providers } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
	};
	const provider = (input.providers ?? PROVIDERS)[input.providerId];
	const who = await provider.identify(credential).catch(() => null);
	if (!who) {
		const saved = await enroll(input.providerId, credential, undefined, options);
		return { signedInAs: saved.email, matched: saved.id === input.account.id, slot: saved.slot };
	}
	// A sign-in to the account in use is put in use too, after it is saved
	// with the login it replaces.
	let saved: AccountRecord;
	const held = await holdSwitch(input.providerId);
	try {
		// Whose login is installed is read from the login itself, not from
		// which account hotseat last put in use.
		const installed = await provider.readAgentCredential().catch(() => null);
		const owner = installed
			? await liveIdentity(provider, installed, await loadRegistry(), await loadCache())
			: undefined;
		// It is replaced only if it is still the same login after naming it.
		const still = await provider.readAgentCredential().catch(() => null);
		const replacing =
			installed !== null &&
			still !== null &&
			fingerprint(still) === fingerprint(installed) &&
			owner !== undefined &&
			who.email.toLowerCase() === owner.email.toLowerCase()
				? installed
				: undefined;
		saved = await saveLogin(input.providerId, who, credential, replacing);
		if (replacing) {
			const now = await putInUse(provider, saved, credential, replacing, true);
			if (now && fingerprint(now) === fingerprint(credential)) {
				await provider.recordIdentity?.(who).catch(() => undefined);
			}
		}
	} finally {
		await held.release();
	}
	await forgetReading(saved.id);
	await publishState({ force: true, ...options });
	return {
		signedInAs: saved.email,
		matched: saved.id === input.account.id,
		slot: saved.slot,
	};
}

/**
 * Writes the current board to disk, which is what watchers react to. Nothing
 * is read from the network that is not already due, so a switch or a settings
 * change is never held up by it; adding an account asks for a fresh read of
 * everything, because its numbers should appear at once.
 */
export async function publishState(
	options: { force?: boolean; providers?: Record<ProviderId, Provider>; now?: number } = {},
): Promise<void> {
	await writeJsonAtomic(statePath(), await collectState(options), 0o600);
}

/**
 * Adds a Claude account from a setup token. Such a token can only run the
 * model, so it must not quietly replace a full sign-in that can also read the
 * account's usage; that takes saying so.
 */
export async function enrollFromToken(
	token: string,
	options: { email?: string; replace?: boolean; providers?: Record<ProviderId, Provider> } = {},
): Promise<AccountRecord> {
	const credential = credentialFromToken(token);
	const identity = await (options.providers ?? PROVIDERS).claude
		.identify(credential)
		.catch(() => null);
	const email = identity?.email ?? options.email;
	if (!email) {
		throw new Error(
			'could not read the account from that token - pass --email to label it yourself',
		);
	}
	const registry = await loadRegistry();
	const existing = accountsFor(registry, 'claude').find(
		(account) => account.email.toLowerCase() === email.toLowerCase(),
	);
	const full = existing?.login ? oauthOf(existing.login) : null;
	if (full && full.refreshToken.length > 0 && !options.replace) {
		throw new Error(
			`${email} already has a full sign-in saved; a setup token has fewer permissions - add --replace to use it anyway`,
		);
	}
	return enroll(
		'claude',
		credential,
		email,
		options.providers ? { providers: options.providers } : {},
	);
}

/** The browser sign-in each service has, run where it cannot disturb the login in use. */
function isolatedLogin(providerId: ProviderId): (email: string) => Promise<Credential> {
	switch (providerId) {
		case 'claude':
			return (email) => loginClaudeIsolated(email);
		case 'codex':
			return () => loginCodexIsolated();
		case 'grok':
			return () => loginGrokIsolated();
		case 'antigravity':
			// It keeps one login, in the Keychain, and signs in only from inside
			// itself, so there is nowhere apart to sign in from here.
			return async (email) => {
				throw new Error(
					`Antigravity signs in from inside its own app - sign in there as ${email}, then run: hotseat add antigravity`,
				);
			};
	}
}

/** A full Claude sign-in, isolated so the current login is left alone. */
export function loginClaudeIsolated(email?: string): Promise<Credential> {
	return loginIsolated(email);
}

/**
 * Signs in to Codex against a throwaway home directory, then keeps the
 * credential that lands there. The isolation matters: Codex revokes the stored
 * refresh token before every sign-in, so logging in normally would break the
 * account already saved on this machine.
 */
export async function loginCodexIsolated(): Promise<Credential> {
	const home = await mkdtemp(join(tmpdir(), 'hotseat-codex-'));
	let child: ReturnType<typeof Bun.spawn> | undefined;
	const lookup = new AbortController();
	return cleanUpEvenIfInterrupted(
		async () => {
			lookup.abort();
			child?.kill();
			await rm(home, { recursive: true, force: true });
		},
		async () => {
			const codex = await agentCommand('codex', { signal: lookup.signal });
			child = Bun.spawn([codex.executable, 'login'], {
				env: { ...codex.env, CODEX_HOME: home },
				stdin: process.stdin.isTTY ? 'inherit' : 'ignore',
				stdout: 'inherit',
				stderr: 'inherit',
			});
			const code = await child.exited;
			if (code !== 0) throw new Error(`the Codex sign-in ended with status ${code}`);
			const credential = await readJson<Credential>(join(home, 'auth.json'));
			if (!credential) throw new Error('the Codex sign-in produced no credential');
			return credential;
		},
	);
}

/**
 * Signs in to Grok against a throwaway home directory, then keeps the login
 * that lands there, so the one in use is left alone.
 */
export async function loginGrokIsolated(): Promise<Credential> {
	const home = await mkdtemp(join(tmpdir(), 'hotseat-grok-'));
	let child: ReturnType<typeof Bun.spawn> | undefined;
	const lookup = new AbortController();
	return cleanUpEvenIfInterrupted(
		async () => {
			lookup.abort();
			child?.kill();
			await rm(home, { recursive: true, force: true });
		},
		async () => {
			const grok = await agentCommand('grok', { signal: lookup.signal });
			child = Bun.spawn([grok.executable, 'login'], {
				env: { ...grok.env, GROK_HOME: home },
				stdin: process.stdin.isTTY ? 'inherit' : 'ignore',
				stdout: 'inherit',
				stderr: 'inherit',
			});
			const code = await child.exited;
			if (code !== 0) throw new Error(`the Grok sign-in ended with status ${code}`);
			const credential = loginIn(await readJson<unknown>(join(home, 'auth.json')));
			if (!credential) throw new Error('the Grok sign-in produced no credential');
			return credential;
		},
	);
}
