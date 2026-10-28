import { ServiceError } from './errors.ts';
import { acquireLock } from './fs.ts';
import { hotseatHome } from './paths.ts';
import { updateRegistry } from './registry.ts';
import { sessionRunning } from './session.ts';
import { holdSwitch } from './switch-lock.ts';
import type { AccountRecord, Credential, Provider } from './types.ts';
import { fingerprint, loadCredential, storeCredential } from './vault.ts';

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
		if (renewed !== stored) await storeCredential(account, renewed);
		return renewed;
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
			// theirs. A newer one is a renewal that never got installed; anything
			// else means the login in use has changed hands since it was named.
			const saved = await loadCredential(owner);
			if (!saved) return installed;
			if (!provider.sharesToken(saved, installed)) {
				if (provider.session.compareAge(saved, installed) <= 0) return installed;
				await provider.writeAgentCredential(saved);
				await settled(owner);
				return saved;
			}
			const renewed = await provider.refreshIfNeeded(installed);
			if (renewed === installed) return installed;
			// Saved with the login it renewed, in one write, so the installed
			// login can be named as this account's even after a restart.
			await updateRegistry((registry) => {
				const record = registry.accounts.find((entry) => entry.id === owner.id);
				if (!record || (record.login && !provider.sharesToken(record.login, installed))) return;
				record.login = structuredClone(renewed);
				record.renewedFrom = fingerprint(installed);
			});
			// Refreshing waits on the service; a login put in meanwhile stays.
			const now = await provider.readAgentCredential();
			if (!now || fingerprint(now) !== fingerprint(named)) return now;
			await provider.writeAgentCredential(renewed);
			await settled(owner);
			return renewed;
		} finally {
			await lock.release();
		}
	} finally {
		await held.release();
	}
}

/** Forgets which login an account's saved one renewed, once that renewal is installed. */
async function settled(owner: Pick<AccountRecord, 'id'>): Promise<void> {
	await updateRegistry((registry) => {
		const record = registry.accounts.find((entry) => entry.id === owner.id);
		if (record) delete record.renewedFrom;
	});
}
