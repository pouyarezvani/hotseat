import { lstat, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hotseatHome } from './paths.ts';
import type { AccountRecord, Credential, Provider, ProviderState } from './types.ts';
import { loadCredential, storeCredential } from './vault.ts';

/**
 * A session runs one command as one account in one terminal. The agent is
 * pointed at a folder of its own under ~/.hotseat/sessions, which links to
 * its everyday setup and holds that account's login and its own history, so
 * every other terminal keeps the shared login and two accounts can work at
 * the same time.
 */

/** One folder per account, named after it, so its history follows it. */
export function sessionDir(provider: Provider, account: Pick<AccountRecord, 'email'>): string {
	const slug = account.email.toLowerCase().replace(/[^a-z0-9@.+_-]/g, '_');
	return join(hotseatHome(), 'sessions', provider.id, slug);
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(
		() => true,
		() => false,
	);
}

/**
 * The account's freshest login, wherever it is. A session refreshes its own
 * copy while it runs, so that copy can be newer than the saved one; whichever
 * is newer is saved and returned.
 */
export async function freshestLogin(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
): Promise<Credential | null> {
	const saved = await loadCredential(account);
	const dir = sessionDir(provider, account);
	const inSession = (await exists(dir)) ? await provider.session.readLogin(dir) : null;
	if (!inSession) return saved;
	if (!saved || provider.session.issuedAt(inSession) > provider.session.issuedAt(saved)) {
		await storeCredential(account, inSession);
		return inSession;
	}
	return saved;
}

/** Whether running as this account needs a session, or is just the shared login. */
export function needsSession(state: ProviderState, accountId: string): boolean {
	return state.activeAccountId !== accountId;
}

/**
 * Makes the account's folder ready: links the shared setup into it, puts the
 * freshest login where the agent will look, and seeds whatever else the
 * agent needs to start there. Returns the environment that points the agent
 * at it.
 */
export async function prepareSession(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
): Promise<{ dir: string; env: Record<string, string> }> {
	const dir = sessionDir(provider, account);
	await mkdir(dir, { recursive: true, mode: 0o700 });

	const home = provider.session.sharedHome();
	for (const name of provider.session.sharedEntries) {
		const source = join(home, name);
		const target = join(dir, name);
		if (!(await exists(source)) || (await exists(target))) continue;
		await symlink(source, target);
	}

	const login = await freshestLogin(provider, account);
	if (!login) throw new Error(`no saved login for ${account.email}`);
	await provider.session.writeLogin(dir, login);
	await provider.session.seed?.(dir);
	return { dir, env: { [provider.session.homeVariable]: dir } };
}

/**
 * After the command ends, keeps whatever the session refreshed, so no later
 * switch installs a token the agent has already rotated past.
 */
export async function captureSession(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
): Promise<boolean> {
	const before = await loadCredential(account);
	const after = await freshestLogin(provider, account);
	return after !== null && JSON.stringify(after) !== JSON.stringify(before);
}
