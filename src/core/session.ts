import { lstat, mkdir, realpath, rm, symlink } from 'node:fs/promises';
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
 * Saves a login for the account unless the saved one is newer, so an older
 * copy found lying around can never revert a fresh sign-in.
 */
export async function adoptIfNewer(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
	candidate: Credential,
): Promise<boolean> {
	const saved = await loadCredential(account);
	if (saved && provider.session.issuedAt(candidate) < provider.session.issuedAt(saved))
		return false;
	if (saved && JSON.stringify(saved) === JSON.stringify(candidate)) return false;
	await storeCredential(account, candidate);
	return true;
}

/** The login a session folder holds, if the folder exists. */
export async function sessionLogin(
	provider: Provider,
	account: Pick<AccountRecord, 'email'>,
): Promise<Credential | null> {
	const dir = sessionDir(provider, account);
	return (await exists(dir)) ? provider.session.readLogin(dir) : null;
}

/** Whether an agent is running as this account in a terminal of its own. */
export async function sessionRunning(
	provider: Provider,
	account: Pick<AccountRecord, 'email'>,
): Promise<boolean> {
	const dir = sessionDir(provider, account);
	return (await exists(dir)) && provider.session.isRunning(dir);
}

/**
 * The account's freshest login, wherever it is. A session refreshes its own
 * copy while it runs, so that copy can be newer than the saved one. A newer
 * session copy is adopted only once the service confirms it is this
 * account's: a sign-in to someone else inside the session must not be
 * filed under this name.
 */
export async function freshestLogin(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
): Promise<Credential | null> {
	const saved = await loadCredential(account);
	const inSession = await sessionLogin(provider, account);
	if (!inSession) return saved;
	if (saved && provider.session.issuedAt(inSession) <= provider.session.issuedAt(saved))
		return saved;
	const who = await provider.identify(inSession).catch(() => undefined);
	if (who?.email.toLowerCase() !== account.email.toLowerCase()) return saved;
	await storeCredential(account, inSession);
	return inSession;
}

/**
 * Removes the account's session folder and whatever its login left behind,
 * such as a keychain item. Refused while an agent is running there.
 */
export async function forgetSession(
	provider: Provider,
	account: Pick<AccountRecord, 'email'>,
): Promise<void> {
	const dir = sessionDir(provider, account);
	if (!(await exists(dir))) return;
	if (await provider.session.isRunning(dir)) {
		throw new Error(`${account.email} is open in another terminal (hotseat run) - close it first`);
	}
	await provider.session.forget(dir);
	await rm(dir, { recursive: true, force: true });
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
		// The real file, not a link to it: the agent replaces a link's target
		// one hop down when it writes, and would cut a chain of two.
		await symlink(await realpath(source), target);
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
