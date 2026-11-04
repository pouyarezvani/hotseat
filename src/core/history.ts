import { readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logEvent, readAllEvents } from './log.ts';
import { hotseatHome } from './paths.ts';
import type { ProviderId } from './types.ts';

export type SwitchReason = 'manual' | 'auto' | 'rotate' | 'next' | 'best';

export interface HistoryEntry {
	at: string;
	provider: ProviderId;
	from?: string;
	to: string;
	reason: SwitchReason;
	/** What the outgoing account's tightest window read when it gave up the seat. */
	leftAtPercent?: number;
}

function timeOf(entry: HistoryEntry): number {
	const time = Date.parse(entry.at);
	return Number.isFinite(time) ? time : Date.now();
}

/** Switches are kept in the event log, filed under the day they happened. */
export async function recordSwitch(entry: HistoryEntry): Promise<void> {
	await logEvent('switch', { ...entry }, timeOf(entry));
}

export async function readHistory(limit = 20): Promise<HistoryEntry[]> {
	const switches = (await readAllEvents()).filter((event) => event.kind === 'switch');
	return switches
		.reverse()
		.slice(0, limit)
		.map(({ kind: _kind, ...entry }) => entry as unknown as HistoryEntry);
}

/**
 * Moves switches from the old `history.jsonl` into the event log, once. The
 * file is renamed before it is read, so two processes cannot both import it,
 * and an import cut short is finished on the next run without duplicates.
 */
export async function migrateHistory(): Promise<void> {
	const legacy = join(hotseatHome(), 'history.jsonl');
	const importing = `${legacy}.importing`;
	await rename(legacy, importing).catch(() => undefined);
	let text: string;
	try {
		text = await readFile(importing, 'utf8');
	} catch {
		return;
	}
	const seen = new Set(
		(await readAllEvents())
			.filter((event) => event.kind === 'switch')
			.map((event) => `${event.at}|${String(event.provider)}|${String(event.to)}`),
	);
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) continue;
		let entry: HistoryEntry;
		try {
			entry = JSON.parse(line) as HistoryEntry;
		} catch {
			continue;
		}
		const key = `${entry.at}|${entry.provider}|${entry.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		await recordSwitch(entry);
	}
	await unlink(importing).catch(() => undefined);
}
