import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFromToken } from '../providers/claude/index.ts';
import { oauthOf } from '../providers/claude/keychain.ts';
import { loginIsolated } from '../providers/claude/login.ts';
import { agentCommand } from './agent-command.ts';
import { collectState, forgetReading, liveIdentity, loadCache, PROVIDERS } from './collect.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { cleanUpEvenIfInterrupted } from './interrupt.ts';
import { statePath } from './paths.ts';
import { accountsFor, loadRegistry, updateRegistry, upsertAccount } from './registry.ts';
import { putInUse } from './renew.ts';
import { holdSwitch } from './switch-lock.ts';
import type { AccountRecord, Credential, Identity, Provider, ProviderId } from './types.ts';
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
	options: { providers?: Record<ProviderId, Provider> } = {},
): Promise<{ account: AccountRecord; email: string } | null> {
	const provider = (options.providers ?? PROVIDERS)[providerId];
	const credential = await provider.readAgentCredential();
	if (!credential) return null;
	const identity = await provider.identify(credential);
	const account = await updateRegistry((registry) => {
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
	return { account, email: identity.email };
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
	const login =
		input.login ??
		(input.providerId === 'claude'
			? (email: string) => loginClaudeIsolated(email)
			: () => loginCodexIsolated());
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
	// Signing in again to the account in use is how a failed login gets fixed,
	// so the new login is put in use too; the agent would otherwise go on with
	// the one that failed. It is saved first, with the login it replaces, so
	// stopping anywhere loses neither the sign-in nor the agent's renewals.
	let saved: AccountRecord;
	const held = await holdSwitch(input.providerId);
	try {
		// Whose login is installed is read from the login itself, not from
		// which account hotseat last put in use: one put in outside hotseat
		// would otherwise be overwritten unsaved.
		const installed = await provider.readAgentCredential().catch(() => null);
		const owner = installed
			? await liveIdentity(provider, installed, await loadRegistry(), await loadCache())
			: undefined;
		// Naming it may have taken a request; it is replaced only if it is
		// still the same login once that answer is in.
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
			const now = await putInUse(provider, saved, credential, replacing);
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
