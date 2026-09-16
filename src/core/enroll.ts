import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFromToken } from '../providers/claude/index.ts';
import { loginIsolated } from '../providers/claude/login.ts';
import { collectState, PROVIDERS } from './collect.ts';
import { readJson, writeJsonAtomic } from './fs.ts';
import { statePath } from './paths.ts';
import { updateRegistry, upsertAccount } from './registry.ts';
import type { AccountRecord, Credential, ProviderId } from './types.ts';
import { storeCredential } from './vault.ts';

/** Saves a credential under the account it belongs to, creating it if new. */
export async function enroll(
	providerId: ProviderId,
	credential: Credential,
	fallbackEmail?: string,
): Promise<AccountRecord> {
	const provider = PROVIDERS[providerId];
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
	// Publish the new picture immediately so the menu bar reflects the account
	// as soon as it exists, rather than at its next scheduled read.
	await publishState();
	return account;
}

/** Writes the current board to disk, which is what watchers react to. */
export async function publishState(): Promise<void> {
	await writeJsonAtomic(statePath(), await collectState({ force: true }), 0o600);
}

export async function enrollFromToken(token: string): Promise<AccountRecord> {
	return enroll('claude', credentialFromToken(token));
}

/** A full Claude sign-in, isolated so the current login is left alone. */
export function loginClaudeIsolated(): Promise<Credential> {
	return loginIsolated();
}

/**
 * Signs in to Codex against a throwaway home directory, then keeps the
 * credential that lands there. The isolation matters: Codex revokes the stored
 * refresh token before every sign-in, so logging in normally would break the
 * account already saved on this machine.
 */
export async function loginCodexIsolated(): Promise<Credential> {
	const home = await mkdtemp(join(tmpdir(), 'hotseat-codex-'));
	try {
		const child = Bun.spawn(['codex', 'login'], {
			env: { ...process.env, CODEX_HOME: home },
			stdin: 'inherit',
			stdout: 'inherit',
			stderr: 'inherit',
		});
		const code = await child.exited;
		if (code !== 0) throw new Error(`the Codex sign-in ended with status ${code}`);
		const credential = await readJson<Credential>(join(home, 'auth.json'));
		if (!credential) throw new Error('the Codex sign-in produced no credential');
		return credential;
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}
