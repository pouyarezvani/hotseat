import { join } from 'node:path';
import { acquireLock, readJson, writeJsonAtomic } from './fs.ts';
import { hotseatHome } from './paths.ts';
import type { AccountRecord, ProviderId } from './types.ts';

/**
 * One use sent to the service. Until a reading of the account's resets taken
 * at least SETTLE_MS after it, a use that got no answer may or may not have
 * happened, and one that did may still be listed.
 */
export interface SentUse {
	resetId: string;
	/** What the reset was called, for saying which one is awaited. */
	title?: string;
	requestId: string;
	at: number;
	/** Recorded before sending and not yet answered. */
	inFlight?: true;
	/** The service answered that it used the reset. */
	used?: true;
}

/** Uses by account, keyed by service and email so they outlast the account being removed and added again. */
export type SentUses = Record<string, SentUse[]>;

/** How long after a use a reading of the account's resets is trusted to show it. */
export const SETTLE_MS = 2 * 60_000;

/**
 * How long a use may still be on its way once recorded: the lookups and the
 * request each give up after twenty seconds.
 */
export const IN_FLIGHT_MS = 60_000;

export function sentKey(providerId: ProviderId, account: Pick<AccountRecord, 'email'>): string {
	return `${providerId}:${account.email.toLowerCase()}`;
}

export function sentPath(): string {
	return join(hotseatHome(), 'reset-pending.json');
}

function isSentUse(value: unknown): value is SentUse {
	if (typeof value !== 'object' || value === null) return false;
	const use = value as Record<string, unknown>;
	return (
		typeof use.resetId === 'string' &&
		typeof use.requestId === 'string' &&
		(use.title === undefined || typeof use.title === 'string') &&
		typeof use.at === 'number' &&
		Number.isFinite(use.at) &&
		(use.inFlight === undefined || use.inFlight === true) &&
		(use.used === undefined || use.used === true)
	);
}

/**
 * The uses sent so far. A missing file is none; a file that cannot be read
 * or does not hold uses throws, since a use it records may still be unsettled.
 */
export async function loadSent(): Promise<SentUses> {
	if (!(await Bun.file(sentPath()).exists())) return {};
	const stored = await readJson<unknown>(sentPath()).catch((error: unknown) => {
		throw new Error(
			`the record of reset uses at ${sentPath()} cannot be read (${error instanceof Error ? error.message : String(error)}) - no reset is used until it is fixed or moved aside`,
		);
	});
	const valid =
		typeof stored === 'object' &&
		stored !== null &&
		!Array.isArray(stored) &&
		Object.values(stored as Record<string, unknown>).every(
			(uses) => Array.isArray(uses) && uses.every(isSentUse),
		);
	if (!valid) {
		throw new Error(
			`the record of reset uses at ${sentPath()} is not one hotseat wrote - no reset is used until it is fixed or moved aside`,
		);
	}
	return stored as SentUses;
}

/**
 * Uses still marked in flight, as uses whose answer was lost, ended now. Only
 * for one who holds reset.lock, so their sender is known to have stopped.
 */
export function cutOff(uses: readonly SentUse[], now: number): SentUse[] {
	return uses.map(({ inFlight, ...use }) => (inFlight ? { ...use, at: now } : use));
}

/**
 * Marks the uses of a sender that stopped before its answer as lost, when no
 * use is being sent now, so the wait to hear how they went can begin.
 */
export async function releaseCutOff(now: number): Promise<void> {
	const marked = (sent: SentUses) =>
		Object.entries(sent).filter(([, uses]) => uses.some((use) => use.inFlight));
	if (marked(await loadSent()).length === 0) return;
	const lock = await acquireLock(hotseatHome(), 0, 'reset.lock').catch(() => null);
	if (!lock) return;
	try {
		for (const [key, uses] of marked(await loadSent())) await saveSent(key, cutOff(uses, now));
	} finally {
		await lock.release();
	}
}

export async function saveSent(key: string, uses: SentUse[]): Promise<void> {
	const sent = await loadSent();
	if (uses.length > 0) sent[key] = uses;
	else delete sent[key];
	await writeJsonAtomic(sentPath(), sent, 0o600);
}
