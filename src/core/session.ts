import { lstat, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { orIfMissing } from './fs.ts';
import { hotseatHome } from './paths.ts';
import { loadRegistry, updateRegistry } from './registry.ts';
import { holdSwitch } from './switch-lock.ts';
import type { AccountRecord, Credential, Provider, ProviderState } from './types.ts';
import { fingerprint, loadCredential, storeCredentialUnless } from './vault.ts';

/**
 * A session runs one command as one account in one terminal. The agent is
 * pointed at a folder of its own under ~/.hotseat/sessions, which links to
 * its everyday setup and holds that account's login and its own history, so
 * every other terminal keeps the shared login and two accounts can work at
 * the same time.
 */

/**
 * One folder per account, named after it, so its history follows it. Any
 * character outside plain letters, digits and `@.+_-` is written as its
 * percent-encoded bytes, so no two addresses ever share a folder.
 */
export function sessionDir(provider: Provider, account: Pick<AccountRecord, 'email'>): string {
	const slug = account.email
		.toLowerCase()
		.replace(/[^a-z0-9@.+_-]/gu, (character) =>
			[...new TextEncoder().encode(character)]
				.map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
				.join(''),
		);
	return join(hotseatHome(), 'sessions', provider.id, slug);
}

/** Whether something is at `path`. Anything but its absence, such as being refused a look, is thrown. */
async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, orIfMissing(false));
}

/**
 * Saves the login in use, `candidate`, as the account's when it is the
 * account's own login renewed by the agent: newer than the saved one, while
 * the saved one is still the login that went in use. A login saved since,
 * such as a fresh sign-in, is kept, and so is one recorded as replacing the
 * candidate. Done under the switch lock, so never while a login is being put
 * in, and decided in one registry write with the login in use read again
 * there, so a candidate read before something else went in is never saved.
 * The lock is taken only when there is something to decide.
 */
export async function adoptIfNewer(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
	candidate: Credential,
): Promise<boolean> {
	const print = fingerprint(candidate);
	const known = (await loadRegistry()).accounts.find((entry) => entry.id === account.id);
	if (!known || (known.renewedFrom !== print && olderThanSaved(provider, candidate, known.login))) {
		return false;
	}
	const held = await holdSwitch(provider.id);
	try {
		return await adoptWhileHeld(provider, account, candidate);
	} finally {
		await held.release();
	}
}

/** adoptIfNewer, for a caller already holding the switch lock. */
export async function adoptWhileHeld(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
	candidate: Credential,
): Promise<boolean> {
	const print = fingerprint(candidate);
	return updateRegistry(async (registry) => {
		const record = registry.accounts.find((entry) => entry.id === account.id);
		if (!record) return false;
		if (record.renewedFrom === print) {
			// The login the saved one was put in to replace is still installed,
			// so the saved one never went in, whatever was recorded before a
			// stop: the login in use is this one.
			if (record.login && record.inUseFrom === fingerprint(record.login)) {
				record.inUseFrom = print;
			}
			return false;
		}
		if (olderThanSaved(provider, candidate, record.login)) return false;
		if (
			record.login &&
			record.inUseFrom !== undefined &&
			record.inUseFrom !== fingerprint(record.login)
		) {
			return false;
		}
		const installed = await provider.readAgentCredential().catch(() => null);
		if (!installed || fingerprint(installed) !== print) return false;
		record.login = structuredClone(candidate);
		record.inUseFrom = print;
		return true;
	});
}

function olderThanSaved(
	provider: Provider,
	candidate: Credential,
	saved: Credential | undefined,
): boolean {
	return (
		saved !== undefined &&
		(provider.session.compareAge(candidate, saved) < 0 ||
			JSON.stringify(saved) === JSON.stringify(candidate))
	);
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
	if (saved && provider.session.compareAge(inSession, saved) <= 0) return saved;
	const who = await provider.identify(inSession).catch(() => undefined);
	if (who?.email.toLowerCase() !== account.email.toLowerCase()) return saved;
	const kept = await storeCredentialUnless(
		account,
		inSession,
		(current) => provider.session.compareAge(inSession, current) <= 0,
	);
	return kept ?? inSession;
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
