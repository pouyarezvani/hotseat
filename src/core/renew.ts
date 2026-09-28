import { ServiceError } from './errors.ts';
import { acquireLock } from './fs.ts';
import { hotseatHome } from './paths.ts';
import type { AccountRecord, Credential, Provider } from './types.ts';
import { loadCredential, storeCredential } from './vault.ts';

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
 * anything else can read the old one. One process at a time per account, and
 * the saved copy is read again once it is this process's turn: a renewal spends
 * the old refresh token, so a second process presenting the copy it read
 * earlier would be refused, and the account written off for nothing.
 */
export async function renewSaved(
	provider: Provider,
	account: Pick<AccountRecord, 'id' | 'email'>,
): Promise<Credential | null> {
	const lock = await acquireLock(hotseatHome(), RENEW_LOCK_WAIT_MS, `renew-${account.id}.lock`);
	try {
		const stored = await loadCredential(account);
		if (!stored) return null;
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

/** The same guard for the login installed on this machine, shared by every account. */
export async function renewInstalled(
	provider: Provider,
	due: (installed: Credential) => boolean,
	save: (renewed: Credential) => Promise<void>,
): Promise<Credential | null> {
	const lock = await acquireLock(
		hotseatHome(),
		RENEW_LOCK_WAIT_MS,
		`renew-${provider.id}-installed.lock`,
	);
	try {
		const installed = await provider.readAgentCredential();
		if (!installed || !due(installed)) return installed;
		const renewed = await provider.refreshIfNeeded(installed);
		if (renewed === installed) return installed;
		await provider.writeAgentCredential(renewed);
		await save(renewed);
		return renewed;
	} finally {
		await lock.release();
	}
}
