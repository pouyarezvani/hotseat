const ESC = '[';

export interface Theme {
	readonly color: boolean;
	readonly truecolor: boolean;
	readonly unicode: boolean;
	readonly width: number;
}

export function theme(stream: NodeJS.WriteStream = process.stdout): Theme {
	const env = process.env;
	const color =
		!env.NO_COLOR && env.TERM !== 'dumb' && (stream.isTTY === true || env.FORCE_COLOR === '1');
	return {
		color,
		truecolor: env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit',
		unicode: !/^(ansi|vt\d+|linux)$/i.test(env.TERM ?? ''),
		width: Math.min(stream.columns ?? 80, 100),
	};
}

/** One accent plus three states. Anything beyond that is decoration. */
const RGB = {
	accent: [122, 162, 247],
	muted: [110, 118, 135],
	faint: [78, 84, 98],
	success: [88, 200, 140],
	warn: [222, 184, 88],
	danger: [226, 90, 96],
	text: [214, 219, 230],
} as const;

const FALLBACK: Record<keyof typeof RGB, number> = {
	accent: 111,
	muted: 244,
	faint: 240,
	success: 78,
	warn: 179,
	danger: 203,
	text: 253,
};

export type Tone = keyof typeof RGB;

export function paint(t: Theme, tone: Tone, text: string): string {
	if (!t.color) return text;
	if (t.truecolor) {
		const [r, g, b] = RGB[tone];
		return `${ESC}38;2;${r};${g};${b}m${text}${ESC}39m`;
	}
	return `${ESC}38;5;${FALLBACK[tone]}m${text}${ESC}39m`;
}

export function onAccent(t: Theme, text: string): string {
	if (!t.color) return text;
	const [r, g, b] = RGB.accent;
	return t.truecolor
		? `${ESC}48;2;${r};${g};${b}m${ESC}38;2;18;20;28m${text}${ESC}0m`
		: `${ESC}48;5;${FALLBACK.accent}m${ESC}30m${text}${ESC}0m`;
}

export function bold(t: Theme, text: string): string {
	return t.color ? `${ESC}1m${text}${ESC}22m` : text;
}

export function dim(t: Theme, text: string): string {
	return t.color ? `${ESC}2m${text}${ESC}22m` : text;
}

export const SYMBOLS = {
	unicode: {
		active: '●',
		idle: '○',
		off: '∅',
		ok: '✓',
		fail: '✗',
		arrow: '›',
		bullet: '·',
		rule: '─',
		corner: '╰',
		branch: '├',
		pipe: '│',
		blockFull: '█',
		eighths: ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'],
		track: '░',
		spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
	},
	ascii: {
		active: '*',
		idle: 'o',
		off: 'x',
		ok: 'v',
		fail: 'x',
		arrow: '>',
		bullet: '-',
		rule: '-',
		corner: '`',
		branch: '|',
		pipe: '|',
		blockFull: '#',
		eighths: ['', '', '', '', '', '', '', ''],
		track: '.',
		spinner: ['|', '/', '-', '\\'],
	},
} as const;

export function symbols(t: Theme): typeof SYMBOLS.unicode | typeof SYMBOLS.ascii {
	return t.unicode ? SYMBOLS.unicode : SYMBOLS.ascii;
}

export function stripAnsi(text: string): string {
	let out = '';
	let index = 0;
	while (index < text.length) {
		if (text.charCodeAt(index) === 0x1b && text[index + 1] === '[') {
			const end = text.indexOf('m', index);
			if (end < 0) break;
			index = end + 1;
			continue;
		}
		out += text[index];
		index += 1;
	}
	return out;
}

export function visibleLength(text: string): number {
	return [...stripAnsi(text)].length;
}

export function pad(text: string, width: number): string {
	return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

/** A section heading with a rule that fills the remaining width. */
export function heading(t: Theme, title: string): string {
	const glyphs = symbols(t);
	const label = bold(t, paint(t, 'text', title));
	const rule = glyphs.rule.repeat(Math.max(0, t.width - visibleLength(title) - 2));
	return `${label}  ${paint(t, 'faint', rule)}`;
}

export function rule(t: Theme): string {
	return paint(t, 'faint', symbols(t).rule.repeat(t.width));
}

export function ok(t: Theme, text: string): string {
	return `${paint(t, 'success', symbols(t).ok)} ${text}`;
}

export function fail(t: Theme, text: string): string {
	return `${paint(t, 'danger', symbols(t).fail)} ${text}`;
}

export function hint(t: Theme, text: string): string {
	return paint(t, 'faint', text);
}

/** The gap to a reset, the way a person says it out loud. */
export function untilReset(resetsAt: string | undefined, now = Date.now()): string {
	if (!resetsAt) return '';
	const target = Date.parse(resetsAt);
	if (!Number.isFinite(target)) return '';
	// A reset already behind us means the numbers shown are from before it.
	if (target <= now) return 'reset';
	const minutes = Math.round((target - now) / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
