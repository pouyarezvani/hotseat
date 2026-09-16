import { createInterface, emitKeypressEvents, type Interface } from 'node:readline';
import { bold, dim, hint, onAccent, paint, symbols, type Theme, theme } from './style.ts';

const SHOW_CURSOR = '[?25h';
const HIDE_CURSOR = '[?25l';
const CLEAR_LINE = '[2K';

export interface Choice<T> {
	label: string;
	value: T;
	hint?: string;
}

export function isInteractive(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * One reader for the whole session. Opening a fresh reader per question would
 * consume the already-finished stdin stream and return an empty line forever,
 * which turns any re-prompt into a spin.
 */
let reader: Interface | undefined;

function lines(): Interface {
	if (!reader) reader = createInterface({ input: process.stdin, terminal: false });
	return reader;
}

export function closePrompt(): void {
	reader?.close();
	reader = undefined;
}

async function readLine(): Promise<string | undefined> {
	for await (const line of lines()) return line.trim();
	return undefined;
}

function renderChoice<T>(t: Theme, choice: Choice<T>, selected: boolean): string {
	const glyphs = symbols(t);
	const marker = selected ? paint(t, 'accent', glyphs.arrow) : ' ';
	const label = selected
		? bold(t, paint(t, 'accent', choice.label))
		: paint(t, 'text', choice.label);
	const tail = choice.hint ? `  ${hint(t, choice.hint)}` : '';
	return ` ${marker} ${label}${tail}`;
}

/**
 * Arrow keys when the terminal can report them, numbers otherwise. The numbered
 * path is not a lesser fallback: it is what makes this work over ssh, in CI, and
 * in any terminal that does not deliver key events.
 */
export async function select<T>(question: string, choices: readonly Choice<T>[]): Promise<T> {
	const t = theme();
	if (!isInteractive()) return selectByNumber(t, question, choices);

	const out = process.stdout;
	const input = process.stdin;
	out.write(`\n${bold(t, question)}\n`);

	let index = 0;
	const draw = (first: boolean): void => {
		if (!first) out.write(`[${choices.length}A`);
		choices.forEach((choice, position) => {
			out.write(`${CLEAR_LINE}${renderChoice(t, choice, position === index)}\n`);
		});
	};

	emitKeypressEvents(input);
	const wasRaw = input.isRaw === true;
	input.setRawMode(true);
	input.resume();
	out.write(HIDE_CURSOR);
	draw(true);
	out.write(dim(t, `${symbols(t).bullet} up and down to move, enter to choose\n`));

	return new Promise<T>((resolve, reject) => {
		const finish = (): void => {
			input.removeListener('keypress', onKey);
			input.setRawMode(wasRaw);
			input.pause();
			out.write(SHOW_CURSOR);
		};
		function onKey(_: string, key: { name?: string; ctrl?: boolean } | undefined): void {
			if (!key) return;
			if (key.ctrl && key.name === 'c') {
				finish();
				reject(new Error('cancelled'));
				return;
			}
			if (key.name === 'up' || key.name === 'k') {
				index = (index - 1 + choices.length) % choices.length;
				out.write('[1A');
				draw(false);
				out.write('\n');
				return;
			}
			if (key.name === 'down' || key.name === 'j') {
				index = (index + 1) % choices.length;
				out.write('[1A');
				draw(false);
				out.write('\n');
				return;
			}
			const digit = Number.parseInt(key.name ?? '', 10);
			if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
				index = digit - 1;
				out.write('[1A');
				draw(false);
				out.write('\n');
				return;
			}
			if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
				finish();
				const chosen = choices[index];
				if (!chosen) {
					reject(new Error('cancelled'));
					return;
				}
				resolve(chosen.value);
			}
		}
		input.on('keypress', onKey);
	});
}

async function selectByNumber<T>(
	t: Theme,
	question: string,
	choices: readonly Choice<T>[],
): Promise<T> {
	process.stdout.write(`\n${bold(t, question)}\n`);
	choices.forEach((choice, index) => {
		const tail = choice.hint ? `  ${hint(t, choice.hint)}` : '';
		process.stdout.write(` ${dim(t, `${index + 1}.`)} ${choice.label}${tail}\n`);
	});
	for (;;) {
		process.stdout.write(hint(t, `choose 1-${choices.length}: `));
		const answer = await readLine();
		if (answer === undefined) throw new Error('cancelled');
		const choice = choices[Number.parseInt(answer, 10) - 1];
		if (choice) return choice.value;
		const matched = choices.find(
			(candidate) => candidate.label.toLowerCase() === answer.toLowerCase(),
		);
		if (matched) return matched.value;
		process.stdout.write(hint(t, 'pick one of the numbers above\n'));
	}
}

export async function askText(question: string, placeholder?: string): Promise<string> {
	const t = theme();
	process.stdout.write(`\n${bold(t, question)}\n`);
	if (placeholder) process.stdout.write(`${hint(t, placeholder)}\n`);
	process.stdout.write(paint(t, 'accent', `${symbols(t).arrow} `));
	const answer = await readLine();
	if (answer === undefined) throw new Error('cancelled');
	return answer;
}

/** Highlights a whole row, for a confirmation the user should not miss. */
export function banner(text: string): string {
	const t = theme();
	return onAccent(t, ` ${text} `);
}
