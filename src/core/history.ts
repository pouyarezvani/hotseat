import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

function historyPath(): string {
	return join(hotseatHome(), 'history.jsonl');
}

/**
 * Append-only so a crash mid-write costs one line rather than the whole log,
 * and so two processes switching at once cannot lose each other's entry.
 */
export async function recordSwitch(entry: HistoryEntry): Promise<void> {
	await mkdir(dirname(historyPath()), { recursive: true, mode: 0o700 });
	await appendFile(historyPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function readHistory(limit = 20): Promise<HistoryEntry[]> {
	const file = Bun.file(historyPath());
	if (!(await file.exists())) return [];
	const lines = (await file.text()).split('\n').filter((line) => line.trim().length > 0);
	const entries: HistoryEntry[] = [];
	for (const line of lines.slice(-limit).reverse()) {
		try {
			entries.push(JSON.parse(line) as HistoryEntry);
		} catch {
			// A torn final line from an interrupted append is skipped, not fatal.
		}
	}
	return entries;
}
