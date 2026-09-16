import type { Settings } from '../core/settings.ts';
import type { ProviderId, State, UsageWindow } from '../core/types.ts';

export interface TitleSpan {
	text: string;
	/** A percentage carries its own severity colour; every other span is plain. */
	percent?: number;
	/** Set on the span naming a service, so a renderer may show its mark instead. */
	provider?: ProviderId;
}

const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex' };
const DOT = ' · ';
/** Between the service, the account and the numbers. A bullet: narrow, unlike a dash. */
const SEP = ' • ';

export type TitleOptions = Pick<
	Settings,
	| 'titleCompact'
	| 'titleShowAccount'
	| 'titlePercentage'
	| 'titleShowModelLimits'
	| 'titleShortenEmail'
>;

function accountLabel(email: string, alias: string | undefined, shorten: boolean): string {
	if (alias) return alias;
	return shorten ? (email.split('@')[0] ?? email) : email;
}

/** A model-scoped window is one the service named after a model, not a clock. */
function isModelLimit(window: UsageWindow): boolean {
	return window.key.startsWith('weekly_scoped:');
}

/**
 * Builds the title as spans so the renderer colours the numbers and leaves the
 * words alone. Percentages are the only thing that changes meaning at a glance,
 * so they are the only thing that carries colour.
 */
export function buildTitle(state: State, options: TitleOptions): TitleSpan[] {
	const spans: TitleSpan[] = [];
	for (const providerId of Object.keys(state.providers) as ProviderId[]) {
		const providerState = state.providers[providerId];
		const active = providerState.accounts.find(
			(account) => account.id === providerState.activeAccountId,
		);
		if (!active) continue;
		if (spans.length > 0) spans.push({ text: options.titleCompact ? '  ' : '   ' });

		const separator = options.titleCompact ? ' ' : SEP;
		spans.push({ text: PROVIDER_LABEL[providerId], provider: providerId });
		if (options.titleShowAccount && !options.titleCompact) {
			spans.push({
				text: `${SEP}${accountLabel(active.email, active.alias, options.titleShortenEmail)}`,
			});
		}
		if (options.titlePercentage === 'none') continue;

		const all = active.usage?.windows ?? [];
		const windows = options.titleShowModelLimits ? all : all.filter((w) => !isModelLimit(w));
		// No numbers yet: the name alone says which account is in use.
		if (windows.length === 0) continue;
		if (options.titlePercentage === 'worst' || options.titleCompact) {
			spans.push(
				{ text: separator },
				{ text: '', percent: Math.max(...windows.map((w) => w.percent)) },
			);
			continue;
		}
		spans.push({ text: separator });
		windows.forEach((window, index) => {
			if (index > 0) spans.push({ text: DOT });
			spans.push({ text: '', percent: window.percent });
		});
	}
	return spans;
}

/** Flattens spans to plain text, which is what a shell prompt wants. */
export function titleText(spans: readonly TitleSpan[]): string {
	return spans
		.map((span) => (span.percent === undefined ? span.text : `${Math.round(span.percent)}%`))
		.join('')
		.trim();
}
