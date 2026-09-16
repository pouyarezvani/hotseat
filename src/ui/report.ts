import { bold, dim, fail, hint, ok, paint, symbols, type Theme, theme } from './style.ts';

const CLEAR_LINE = '[2K\r';
const HIDE_CURSOR = '[?25l';
const SHOW_CURSOR = '[?25h';

export function say(text = ''): void {
	process.stdout.write(`${text}\n`);
}

export function note(text: string): void {
	say(hint(theme(), text));
}

export function success(text: string): void {
	say(ok(theme(), text));
}

export function problem(text: string): void {
	process.stderr.write(`${fail(theme(), text)}\n`);
}

/**
 * A step that shows progress while it runs and resolves to a single line. Falls
 * back to one static line when the output is not a terminal, so piped output and
 * logs stay readable instead of filling with redraw escapes.
 */
export async function step<T>(label: string, work: () => Promise<T>): Promise<T> {
	const t = theme();
	if (!process.stdout.isTTY) {
		say(hint(t, `${symbols(t).arrow} ${label}`));
		return work();
	}
	const frames = symbols(t).spinner;
	let frame = 0;
	process.stdout.write(HIDE_CURSOR);
	const timer = setInterval(() => {
		const glyph = frames[frame % frames.length] ?? '';
		process.stdout.write(`${CLEAR_LINE}${paint(t, 'accent', glyph)} ${hint(t, label)}`);
		frame += 1;
	}, 80);
	try {
		const result = await work();
		clearInterval(timer);
		process.stdout.write(`${CLEAR_LINE}${ok(t, label)}\n${SHOW_CURSOR}`);
		return result;
	} catch (error) {
		clearInterval(timer);
		process.stdout.write(`${CLEAR_LINE}${fail(t, label)}\n${SHOW_CURSOR}`);
		throw error;
	}
}

/** Numbered guidance for something the user has to do outside this process. */
export function instructions(t: Theme, title: string, steps: readonly string[]): string {
	const glyphs = symbols(t);
	const lines = [bold(t, title)];
	steps.forEach((text, index) => {
		const marker = paint(t, 'accent', `${index + 1}`);
		lines.push(`  ${marker}${dim(t, '.')} ${text}`);
	});
	lines.push(`  ${paint(t, 'faint', glyphs.rule.repeat(3))}`);
	return lines.join('\n');
}
