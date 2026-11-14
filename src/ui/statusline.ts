import { stat } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from '../core/fs.ts';
import { type ServiceStatus, worthShowing } from '../core/service-status.ts';
import type { ProviderId, State } from '../core/types.ts';
import { paint, type Theme, untilReset } from './style.ts';

/** The board as it was last worked out, kept for a status line to read without asking anything. */
export interface Snapshot extends State {
	services?: Partial<Record<ProviderId, ServiceStatus>>;
}

/** Past this the numbers are old enough to say so. */
export const STALE_AFTER_MS = 10 * 60_000;

function tone(percent: number): 'success' | 'warn' | 'danger' {
	if (percent >= 90) return 'danger';
	if (percent >= 65) return 'warn';
	return 'success';
}

/**
 * One line for an agent's status bar: the account in use, each of its limits
 * with when it resets, the limit that will fill first at the present pace, and
 * the service's own trouble when it reports any.
 */
export function statusLine(
	snapshot: Snapshot | null,
	provider: ProviderId,
	t: Theme,
	now: number,
): string {
	if (!snapshot) return paint(t, 'faint', 'hotseat: no reading yet');
	const state = snapshot.providers[provider];
	const active = state?.accounts.find((account) => account.id === state.activeAccountId);
	if (!active) return paint(t, 'faint', 'hotseat: no account in use');
	const name = active.alias ?? active.email.split('@')[0] ?? active.email;
	const parts = [paint(t, 'text', name)];
	const windows = (active.usage?.windows ?? []).filter((window) => !window.hidden);
	for (const window of windows) {
		const reset = untilReset(window.resetsAt, now);
		parts.push(
			`${paint(t, 'muted', window.label)} ${paint(t, tone(window.percent), `${Math.round(window.percent)}%`)}${
				reset ? paint(t, 'faint', ` ${reset}`) : ''
			}`,
		);
	}
	const error = active.usage?.error;
	if (windows.length === 0) {
		parts.push(paint(t, 'faint', error ?? active.usage?.note ?? 'no reading yet'));
	} else if (error) {
		// The numbers are the last good ones, so the failure is said beside them.
		parts.push(paint(t, 'danger', `last read failed: ${error}`));
	}
	const filling = windows
		.filter((window) => window.fullAt !== undefined)
		.sort((a, b) => Date.parse(a.fullAt ?? '') - Date.parse(b.fullAt ?? ''))[0];
	if (filling) {
		parts.push(paint(t, 'warn', `${filling.label} full in ${untilReset(filling.fullAt, now)}`));
	}
	const service = snapshot.services?.[provider];
	if (worthShowing(service)) {
		parts.push(paint(t, service.level === 'minor' ? 'warn' : 'danger', service.summary));
	}
	// How old the numbers are, not how old the board is: a board worked out a
	// moment ago may still be carrying a reading from hours back.
	const read = Date.parse(active.usage?.fetchedAt ?? snapshot.updatedAt);
	const age = now - (Number.isFinite(read) ? read : Date.parse(snapshot.updatedAt));
	if (age > STALE_AFTER_MS) {
		parts.push(paint(t, 'faint', `read ${untilReset(new Date(now + age).toISOString(), now)} ago`));
	}
	return parts.join(paint(t, 'faint', ' · '));
}

/** One word of a shell command, quoted so spaces and quotes in it stay part of it. */
export function shellQuote(word: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Sets hotseat's line as Claude Code's status line, unless it already has one.
 * The settings file keeps the permissions it had, and a new one is private:
 * it can hold tokens.
 */
export async function installStatusLine(
	path: string,
	launch: readonly string[],
): Promise<'installed' | 'taken'> {
	const settings = (await readJson<Record<string, unknown>>(path)) ?? {};
	if (settings.statusLine !== undefined) return 'taken';
	const mode = await stat(path)
		.then((info) => info.mode & 0o777)
		.catch(() => 0o600);
	const command = [...launch, 'statusline'].map(shellQuote).join(' ');
	await writeJsonAtomic(path, { ...settings, statusLine: { type: 'command', command } }, mode);
	return 'installed';
}
