import { acquireLock, type Lock } from './fs.ts';
import { hotseatHome } from './paths.ts';
import type { ProviderId } from './types.ts';

/** How long a change to the login in use waits for another on the same service. */
const SWITCH_WAIT_MS = 120_000;

/**
 * Holds the right to change which login a service has in use. Every switch,
 * by hand or automatic, signing in again, removing an account and renewing the
 * installed login hold it, so none acts on what another is halfway through
 * changing. It is taken before the renewal lock, never after.
 */
export function holdSwitch(provider: ProviderId): Promise<Lock> {
	return acquireLock(hotseatHome(), SWITCH_WAIT_MS, `switch-${provider}.lock`);
}
