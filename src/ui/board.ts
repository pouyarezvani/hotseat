import type { AccountState, ProviderId, State, UsageWindow } from '../core/types.ts';
import {
	bold,
	dim,
	heading,
	pad,
	paint,
	symbols,
	type Theme,
	untilReset,
	visibleLength,
} from './style.ts';

const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };

export interface BoardOptions {
	readonly theme: Theme;
	readonly barWidth: number;
	readonly now: number;
}

type Level = 'success' | 'warn' | 'danger';

function levelFor(percent: number): Level {
	if (percent >= 90) return 'danger';
	if (percent >= 65) return 'warn';
	return 'success';
}

/** A meter whose filled portion carries the severity and whose track recedes. */
export function meter(t: Theme, percent: number, width: number): string {
	const glyphs = symbols(t);
	const clamped = Math.max(0, Math.min(100, percent));
	const exact = (clamped / 100) * width;
	const full = Math.floor(exact);
	const remainder = Math.floor((exact - full) * 8);
	const partial =
		t.unicode && remainder > 0 && full < width ? (glyphs.eighths[remainder] ?? '') : '';
	const filled = glyphs.blockFull.repeat(full) + partial;
	const rest = Math.max(0, width - full - (partial.length > 0 ? 1 : 0));
	return paint(t, levelFor(clamped), filled) + paint(t, 'faint', glyphs.track.repeat(rest));
}

export function renderBoard(state: State, options: BoardOptions): string {
	const t = options.theme;
	const blocks: string[] = [];
	for (const providerId of Object.keys(state.providers) as ProviderId[]) {
		const providerState = state.providers[providerId];
		if (providerState.accounts.length === 0) continue;
		const ready = providerState.accounts.filter(
			(account) => !account.disabled && headroomOf(account) > 3,
		).length;
		const lines = [
			heading(t, PROVIDER_LABEL[providerId]),
			dim(t, `${ready} of ${providerState.accounts.length} ready`),
			'',
		];
		for (const account of providerState.accounts) {
			lines.push(...renderAccount(account, account.id === providerState.activeAccountId, options));
		}
		blocks.push(lines.join('\n'));
	}
	if (blocks.length === 0) {
		return [
			dim(t, 'No accounts yet.'),
			'',
			`  ${paint(t, 'accent', symbols(t).arrow)} ${bold(t, 'hotseat add')}   ${dim(t, 'sign in and add your first')}`,
		].join('\n');
	}
	return blocks.join('\n\n');
}

function renderAccount(account: AccountState, isActive: boolean, options: BoardOptions): string[] {
	const t = options.theme;
	const glyphs = symbols(t);
	const mark = account.disabled ? glyphs.off : isActive ? glyphs.active : glyphs.idle;
	const markColor = account.disabled ? 'faint' : isActive ? levelFor(worstOf(account)) : 'faint';
	const name = account.alias ?? account.email;
	const title = isActive
		? bold(t, paint(t, 'text', name))
		: account.disabled
			? paint(t, 'faint', name)
			: paint(t, 'text', name);
	const number = paint(t, 'faint', `${account.slot}`);
	const plan = account.plan ? `  ${paint(t, 'faint', account.plan)}` : '';
	const head = ` ${paint(t, markColor, mark)} ${number}  ${title}${plan}`;

	const windows = account.usage?.windows ?? [];
	if (account.usage?.error) {
		return [
			head,
			`   ${paint(t, 'faint', glyphs.corner)} ${paint(t, 'danger', account.usage.error)}`,
			'',
		];
	}
	if (windows.length === 0) {
		return [head, `   ${paint(t, 'faint', glyphs.corner)} ${dim(t, 'no reading yet')}`, ''];
	}
	const labelWidth = Math.max(...windows.map((window) => visibleLength(window.label)));
	const rows = windows.map((window, index) =>
		renderWindow(window, labelWidth, index === windows.length - 1, options),
	);
	return [head, ...rows, ''];
}

function renderWindow(
	window: UsageWindow,
	labelWidth: number,
	isLast: boolean,
	options: BoardOptions,
): string {
	const t = options.theme;
	const glyphs = symbols(t);
	const connector = paint(t, 'faint', isLast ? glyphs.corner : glyphs.branch);
	const label = paint(t, 'muted', pad(window.label, labelWidth));
	const value = paint(t, levelFor(window.percent), `${Math.round(window.percent)}%`.padStart(4));
	const reset = untilReset(window.resetsAt, options.now);
	const tail = reset ? `  ${paint(t, 'faint', reset)}` : '';
	return `   ${connector} ${label}  ${meter(t, window.percent, options.barWidth)} ${value}${tail}`;
}

function worstOf(account: AccountState): number {
	const windows = account.usage?.windows ?? [];
	return windows.length === 0 ? 0 : Math.max(...windows.map((window) => window.percent));
}

export function headroomOf(account: AccountState): number {
	const windows = account.usage?.windows ?? [];
	if (windows.length === 0) return 100;
	return 100 - worstOf(account);
}
