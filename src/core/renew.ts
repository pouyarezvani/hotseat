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
		// A login in use that cannot be read may hold this same token, so
		// nothing is renewed until it can be.
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
				// Reading the saved login waits on the registry; a login put in
				// meanwhile stays.
				const now = await provider.readAgentCredential();
				if (!now || fingerprint(now) !== fingerprint(named)) return now;
				await provider.writeAgentCredential(saved);
				await settled(owner, saved);
				return saved;
			}
			const renewed = await provider.refreshIfNeeded(installed);
			if (renewed === installed) return installed;
			// Saved with the login it renewed, in one write, so the installed
			// login can be named as this account's even after a restart. A
			// sign-in saved to the owner meanwhile is kept, and is what gets
			// installed in place of the spent token.
			const kept = await updateRegistry((registry): Credential | null => {
				const record = registry.accounts.find((entry) => entry.id === owner.id);
				if (!record) return null;
				if (record.login && !provider.sharesToken(record.login, installed)) {
					record.renewedFrom = fingerprint(installed);
					return structuredClone(record.login);
				}
				record.login = structuredClone(renewed);
				record.renewedFrom = fingerprint(installed);
				return null;
			});
			const login = kept ?? renewed;
			// Refreshing waits on the service; a login put in meanwhile stays.
			const now = await provider.readAgentCredential();
			if (!now || fingerprint(now) !== fingerprint(named)) return now;
			await provider.writeAgentCredential(login);
			await settled(owner, login);
			return login;
		} finally {
			await lock.release();
		}
	} finally {
		await held.release();
	}
}

/**
 * Records that `login` went in use for the owner, and forgets which login its
 * saved one replaced, which is no longer installed.
 */
async function settled(owner: Pick<AccountRecord, 'id'>, login: Credential): Promise<void> {
	await updateRegistry((registry) => {
		const record = registry.accounts.find((entry) => entry.id === owner.id);
		if (!record) return;
		delete record.renewedFrom;
		record.inUseFrom = fingerprint(login);
	});
}
