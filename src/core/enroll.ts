import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFromToken } from '../providers/claude/index.ts';
import { oauthOf } from '../providers/claude/keychain.ts';
import { loginIsolated } from '../providers/claude/login.ts';
import { collectState, forgetReading, PROVIDERS } from './collect.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { cleanUpEvenIfInterrupted } from './interrupt.ts';
import { statePath } from './paths.ts';
import { accountsFor, loadRegistry, updateRegistry, upsertAccount } from './registry.ts';
import type { AccountRecord, Credential, Provider, ProviderId } from './types.ts';
import { storeCredential } from './vault.ts';

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
	const account = await updateRegistry((registry) =>
		upsertAccount(registry, {
			provider: providerId,
			email,
			...(identity?.plan ? { plan: identity.plan } : {}),
		}),
	);
	await storeCredential(account, credential);
	// Whatever was read, or failed, with the old login no longer applies.
	await forgetReading(account.id);
	// Publish the new picture immediately so the menu bar reflects the account
	// as soon as it exists, rather than at its next scheduled read.
	await publishState({ force: true, ...options });
	return account;
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
	const saved = await enroll(input.providerId, credential, undefined, {
		...(input.providers ? { providers: input.providers } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
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
	options: { email?: string; replace?: boolean } = {},
): Promise<AccountRecord> {
	const credential = credentialFromToken(token);
	const identity = await PROVIDERS.claude.identify(credential).catch(() => null);
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
	return enroll('claude', credential, email);
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
	return cleanUpEvenIfInterrupted(
		async () => {
			child?.kill();
			await rm(home, { recursive: true, force: true });
		},
		async () => {
			child = Bun.spawn(['codex', 'login'], {
				env: { ...process.env, CODEX_HOME: home },
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
