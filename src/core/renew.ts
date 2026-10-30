import { ServiceError } from './errors.ts';
import { acquireLock } from './fs.ts';
import { hotseatHome } from './paths.ts';
import { loadRegistry, updateRegistry } from './registry.ts';
import { sessionRunning } from './session.ts';
import { holdSwitch } from './switch-lock.ts';
import type { AccountRecord, Credential, Provider } from './types.ts';
import { fingerprint, loadCredential, storeCredentialUnless } from './vault.ts';

/** Long enough to wait out another process's renewal, which may itself wait on the service. */
const RENEW_LOCK_WAIT_MS = 45_000;

/** A renewal the service refused, naming the exact copy it refused. */
export class RenewalFailed extends ServiceError {
	readonly login: Credential;

	constructor(login: Credential, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(
			message,
			cause instanceof ServiceError ? cause.status : undefined,
			cause instanceof ServiceError ? cause.retryAfterMs : undefined,
		);
		this.name = 'RenewalFailed';
		this.login = login;
	}
}

/**
 * Renews an account's saved login if it is due, and saves the result before
 * anything else can read the old one. One renewal at a time per service, the
 * installed login's included, and everything is read again once it is this
 * process's turn: a renewal spends the old refresh token, so a second process
 * presenting the copy it read earlier would be refused, and the account
 * written off for nothing. A saved copy holding the same token as the login in
 * use, or as a session running as the account, is left to whoever holds it.
 */
export async function renewSaved(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
): Promise<Credential | null> {
	const lock = await acquireLock(hotseatHome(), RENEW_LOCK_WAIT_MS, `renew-${provider.id}.lock`);
	try {
		const stored = await loadCredential(account);
		if (!stored) return null;
		// Nothing is renewed while the login in use cannot be read.
		const installed = await provider.readAgentCredential().catch(() => undefined);
		if (installed === undefined) return stored;
		if (installed && provider.sharesToken(installed, stored)) {
			throw new Error(`${account.email} was just put in use - it is read from there next time`);
		}
		if (await sessionRunning(provider, account)) {
			throw new Error(`${account.email} is open in another terminal (hotseat run)`);
		}
		let renewed: Credential;
		try {
			renewed = await provider.refreshIfNeeded(stored);
		} catch (error) {
			throw new RenewalFailed(stored, error);
		}
		if (renewed === stored) return stored;
		// Saved only while the saved copy is still the one renewed. A sign-in
		// saved while the service answered is kept, and is what gets used.
		const kept = await storeCredentialUnless(
			account,
			renewed,
			(current) => !provider.sharesToken(current, stored),
		);
		return kept ?? renewed;
	} finally {
		await lock.release();
	}
}

/**
 * Renews the login installed on this machine, `named` as belonging to `owner`,
 * and only while that exact login is still the one installed. It is
 * done while holding the switch lock, so nothing switches the login in use
 * meanwhile, and the renewal is saved to the owner before it is installed: if
 * installing it fails, the next attempt finds the owner's saved copy newer
 * than the installed one and installs that, rather than presenting the spent
 * token again. The renewal is not saved over a login the owner was given since,
 * such as a fresh sign-in.
 */
export async function renewInstalled(
	provider: Provider,
	owner: Pick<AccountRecord, 'id'>,
	named: Credential,
	due: (installed: Credential) => boolean,
): Promise<Credential | null> {
	const held = await holdSwitch(provider.id);
	try {
		const lock = await acquireLock(hotseatHome(), RENEW_LOCK_WAIT_MS, `renew-${provider.id}.lock`);
		try {
			const installed = await provider.readAgentCredential();
			if (!installed || fingerprint(installed) !== fingerprint(named)) return installed;
			if (!due(installed)) return installed;
			// The owner's saved copy holds the installed token while the login is
			// theirs. One recorded as replacing the installed login, or newer than
			// it, is a renewal or sign-in that never got installed; anything else
			// means the login in use has changed hands since it was named.
			const record = (await loadRegistry()).accounts.find((entry) => entry.id === owner.id);
			const saved = record?.login;
			if (!saved) return installed;
			if (!provider.sharesToken(saved, installed)) {
				const replacesInstalled =
					record?.renewedFrom === fingerprint(installed) ||
					provider.session.compareAge(saved, installed) > 0;
				if (!replacesInstalled) return installed;
				return putInUse(provider, owner, saved, named, true);
			}
			const renewed = await provider.refreshIfNeeded(installed);
			if (renewed === installed) return installed;
			// Saved in one write with the login it renewed, which names the
			// installed login as this account's until the renewal is in. A
			// sign-in saved to the owner meanwhile is kept, and installed in place
			// of the spent token.
			const kept = await updateRegistry((registry): Credential | null => {
				const record = registry.accounts.find((entry) => entry.id === owner.id);
				if (!record) return null;
				record.renewedFrom = fingerprint(installed);
				if (record.login && !provider.sharesToken(record.login, installed)) {
					return structuredClone(record.login);
				}
				record.login = structuredClone(renewed);
				return null;
			});
			return putInUse(provider, owner, kept ?? renewed, named, true);
		} finally {
			await lock.release();
		}
	} finally {
		await held.release();
	}
}

/**
 * Installs `login` as the owner's in place of `named` (null when nothing was
 * installed), and only while that is still what is installed, read again
 * after every registry write. The login is recorded as the one in use before
 * it is installed; if installing fails, or something else went in meanwhile,
 * the record goes back to what it was, or to the login still installed. When
 * `named` is the owner's own login, it is recorded as the one being replaced.
 * Returns the login installed afterwards.
 */
export async function putInUse(
	provider: Provider,
	owner: Pick<AccountRecord, 'id'>,
	login: Credential,
	named: Credential | null,
	namedIsOwners: boolean,
): Promise<Credential | null> {
	const print = fingerprint(login);
	const before = await updateRegistry((registry) => {
		const record = registry.accounts.find((entry) => entry.id === owner.id);
		if (!record) return undefined;
		const previous = record.inUseFrom;
		record.inUseFrom = print;
		if (namedIsOwners && named) record.renewedFrom = fingerprint(named);
		return previous;
	});
	const undo = (): Promise<void> =>
		updateRegistry((registry) => {
			const record = registry.accounts.find((entry) => entry.id === owner.id);
			if (!record || record.inUseFrom !== print) return;
			const back = before ?? (named ? fingerprint(named) : undefined);
			if (back === undefined) delete record.inUseFrom;
			else record.inUseFrom = back;
		});
	try {
		const now = await provider.readAgentCredential();
		if ((now ? fingerprint(now) : null) !== (named ? fingerprint(named) : null)) {
			await undo();
			return now;
		}
		await provider.writeAgentCredential(login);
	} catch (error) {
		await undo();
		throw error;
	}
	await updateRegistry((registry) => {
		const record = registry.accounts.find((entry) => entry.id === owner.id);
		if (record) delete record.renewedFrom;
	});
	return login;
}
