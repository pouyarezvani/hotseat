import { type ServiceStatus, worthShowing } from '../core/service-status.ts';
import { headroom, MIN_USABLE_HEADROOM } from '../core/switch.ts';
import type { AccountState, LimitReset, ProviderId, State, UsageWindow } from '../core/types.ts';
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

const PROVIDER_LABEL: Record<ProviderId, string> = {
	claude: 'Claude',
	codex: 'Codex',
	antigravity: 'Antigravity',
	grok: 'Grok',
};

export interface BoardOptions {
	readonly theme: Theme;
	readonly barWidth: number;
	readonly now: number;
	/** Which models' own limits count, mirroring the switching setting. */
	readonly modelLimits?: string[];
	/** What each service's status page says, shown only when it reports trouble. */
	readonly services?: Partial<Record<ProviderId, ServiceStatus>>;
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
		// The same rule the switcher applies, and excluding the account in use,
		// so this count never contradicts what switching would actually do.
		const spare = providerState.accounts.filter(
			(account) =>
				!account.disabled &&
				account.id !== providerState.activeAccountId &&
				account.usage?.errorKind !== 'auth' &&
				headroom(account, options.modelLimits ?? []) >= MIN_USABLE_HEADROOM,
		).length;
		const lines = [
			heading(t, PROVIDER_LABEL[providerId]),
			dim(t, spare === 0 ? 'nothing to switch to' : `${spare} to switch to`),
			'',
		];
		const service = options.services?.[providerId];
		if (worthShowing(service)) {
			lines.splice(2, 0, paint(t, service.level === 'minor' ? 'warn' : 'danger', service.summary));
		}
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

	const windows = (account.usage?.windows ?? []).filter((window) => !window.hidden);
	const error = account.usage?.error;
	const resets = (account.usage?.limitResets ?? []).filter((reset) => {
		const at = reset.expiresAt ? Date.parse(reset.expiresAt) : Number.NaN;
		return !Number.isFinite(at) || at > options.now;
	});
	if (windows.length === 0) {
		const hiddenOnly = (account.usage?.windows.length ?? 0) > 0;
		const said = error
			? paint(t, 'danger', error)
			: dim(t, hiddenOnly ? 'every limit hidden' : (account.usage?.note ?? 'no reading yet'));
		return [
			head,
			`   ${paint(t, 'faint', resets.length > 0 ? glyphs.branch : glyphs.corner)} ${said}`,
			...resets.map((reset, index) => renderReset(reset, index === resets.length - 1, options)),
			'',
		];
	}
	const labelWidth = Math.max(...windows.map((window) => visibleLength(window.label)));
	const rows = windows.map((window, index) =>
		renderWindow(
			window,
			labelWidth,
			index === windows.length - 1 && resets.length === 0 && !error,
			options,
		),
	);
	rows.push(
		...resets.map((reset, index) =>
			renderReset(reset, index === resets.length - 1 && !error, options),
		),
	);
	// The numbers are the last good reading, so the failure sits under them
	// rather than replacing them.
	if (error) {
		rows.push(
			`   ${paint(t, 'faint', glyphs.corner)} ${paint(t, 'danger', `last read failed: ${error}`)}`,
		);
	}
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
	const pace = window.fullAt
		? `  ${paint(t, 'warn', `full in ${untilReset(window.fullAt, options.now)} at this pace`)}`
		: '';
	const tail = `${reset ? `  ${paint(t, 'faint', reset)}` : ''}${pace}`;
	return `   ${connector} ${label}  ${meter(t, window.percent, options.barWidth)} ${value}${tail}`;
}

/** Within this long of running out, a reset's expiry is drawn as a warning. */
const EXPIRY_SOON_MS = 3 * 24 * 60 * 60_000;

/** How many midnights lie between two moments, in local time. */
function calendarDaysBetween(from: number, to: number): number {
	const midnight = (time: number): number => {
		const date = new Date(time);
		return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	};
	return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

/** One free limit reset: what it is called, what it clears, and when it runs out. */
function renderReset(reset: LimitReset, isLast: boolean, options: BoardOptions): string {
	const t = options.theme;
	const glyphs = symbols(t);
	const connector = paint(t, 'faint', isLast ? glyphs.corner : glyphs.branch);
	const name = paint(
		t,
		reset.blocked ? 'faint' : 'muted',
		reset.left ? `${reset.title} x${reset.left}` : reset.title,
	);
	const clears = [...reset.clears, ...(reset.givesBack ? [`its share of ${reset.givesBack}`] : [])];
	const what = clears.length > 0 ? `  ${paint(t, 'faint', clears.join(' + '))}` : '';
	const at = reset.expiresAt ? Date.parse(reset.expiresAt) : Number.NaN;
	let when = '';
	if (Number.isFinite(at)) {
		const soon = at - options.now < EXPIRY_SOON_MS;
		const date = new Date(at);
		const days = calendarDaysBetween(options.now, at);
		const said =
			days <= 0
				? `expires today (${untilReset(reset.expiresAt, options.now)})`
				: `expires ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (${days} day${days === 1 ? '' : 's'})`;
		when = `  ${paint(t, soon ? 'warn' : 'faint', said)}`;
	}
	const blocked = reset.blocked ? `  ${paint(t, 'faint', `(${reset.blocked})`)}` : '';
	return `   ${connector} ${name}${what}${when}${blocked}`;
}

function worstOf(account: AccountState): number {
	const windows = account.usage?.windows ?? [];
	return windows.length === 0 ? 0 : Math.max(...windows.map((window) => window.percent));
}

/**
 * Re-exported from the switcher rather than defined again here. The two used to
 * disagree about an account with no reading, which made the header promise a
 * switch the switcher would refuse.
 */
export { headroom as headroomOf } from '../core/switch.ts';
