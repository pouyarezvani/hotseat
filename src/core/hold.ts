import { loadRegistry, updateRegistry } from './registry.ts';
import type { AccountRecord, Provider } from './types.ts';

/**
 * Whether an agent process that may hold this account's login, after a switch
 * away from it, is still running. When the running agents cannot be listed, it
 * is taken that one is. A hold not yet settled is settled here: every agent
 * running now may hold the login. The record is cleared once none is left.
 * Only what was read is settled or cleared: a hold set meanwhile, by a switch
 * or an import, is kept, and counts as held.
 */
export async function heldByOpenSession(
	provider: Provider,
	account: Pick<AccountRecord, 'id'>,
): Promise<boolean> {
	const record = (await loadRegistry()).accounts.find((entry) => entry.id === account.id);
	if (!record?.holdUnsettled && (!record?.heldBy || record.heldBy.length === 0)) return false;
	const running = await provider.runningProcesses().catch(() => null);
	if (running === null) return true;
	const alive = new Set(running.map((process) => process.pid));
	const holders = record.holdUnsettled
		? [...alive]
		: (record.heldBy ?? []).filter((pid) => alive.has(pid));
	const settling = record.holdUnsettled === true;
	return updateRegistry((registry) => {
		const entry = registry.accounts.find((candidate) => candidate.id === account.id);
		if (!entry) return holders.length > 0;
		const kept = [...new Set([...(entry.heldBy ?? []), ...holders])].filter((pid) =>
			alive.has(pid),
		);
		if (kept.length > 0) entry.heldBy = kept;
		else delete entry.heldBy;
		if (settling) delete entry.holdUnsettled;
		return kept.length > 0 || entry.holdUnsettled === true;
	});
}
