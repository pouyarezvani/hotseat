import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logDir } from './paths.ts';

export const LOG_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export interface LogEvent {
	at: string;
	kind: string;
	[field: string]: unknown;
}

/** The file for the local calendar day containing `time`, such as `2026-11-04.jsonl`. */
export function dayFile(time: number): string {
	const date = new Date(time);
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}.jsonl`;
}

function dayOf(name: string): number | null {
	const match = DAY_FILE.exec(name);
	if (!match) return null;
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

let purgedFor = '';

async function purgeOld(now: number): Promise<void> {
	const today = dayFile(now);
	if (purgedFor === `${logDir()}|${today}`) return;
	purgedFor = `${logDir()}|${today}`;
	const cutoff = (dayOf(today) ?? now) - LOG_RETENTION_DAYS * DAY_MS;
	for (const name of await readdir(logDir())) {
		const day = dayOf(name);
		if (day !== null && day < cutoff) await unlink(join(logDir(), name)).catch(() => undefined);
	}
}

/**
 * Appends one event to today's log and drops logs older than 30 days. Never
 * throws: a log that cannot be written must not stop the work it describes.
 */
export async function logEvent(
	kind: string,
	data: Record<string, unknown> = {},
	now = Date.now(),
): Promise<void> {
	try {
		await mkdir(logDir(), { recursive: true, mode: 0o700 });
		const line = JSON.stringify({ at: new Date(now).toISOString(), kind, ...data });
		await appendFile(join(logDir(), dayFile(now)), `${line}\n`, { mode: 0o600 });
		await purgeOld(now);
	} catch {
		return;
	}
}

/** Events from the last `days` local days, oldest first. */
export async function readEvents(days: number, now = Date.now()): Promise<LogEvent[]> {
	const events: LogEvent[] = [];
	for (let back = Math.max(1, days) - 1; back >= 0; back--) {
		const file = Bun.file(join(logDir(), dayFile(now - back * DAY_MS)));
		if (!(await file.exists())) continue;
		for (const line of (await file.text()).split('\n')) {
			if (line.trim().length === 0) continue;
			try {
				events.push(JSON.parse(line) as LogEvent);
			} catch {}
		}
	}
	return events;
}
