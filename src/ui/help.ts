import { bold, dim, heading, pad, paint, symbols, theme, visibleLength } from './style.ts';

interface Entry {
	usage: string;
	what: string;
}

interface Group {
	title: string;
	entries: Entry[];
}

const GROUPS: Group[] = [
	{
		title: 'Look',
		entries: [
			{ usage: 'status', what: 'every account and how full each limit is' },
			{ usage: 'list', what: 'one line per account' },
			{ usage: 'title', what: 'one-line summary, for a shell prompt' },
			{ usage: 'history', what: 'recent switches' },
		],
	},
	{
		title: 'Switch',
		entries: [
			{ usage: 'switch <service> <account>', what: 'switch to a specific account' },
			{ usage: 'best <service>', what: 'switch to the one with the most left' },
			{ usage: 'rotate <service>', what: 'switch to the next in order' },
			{ usage: 'next <service>', what: 'switch to the next with room' },
			{ usage: 'auto', what: 'keep switching as limits fill up' },
		],
	},
	{
		title: 'Accounts',
		entries: [
			{ usage: 'add [service]', what: 'sign in and add an account' },
			{ usage: 'remove <service> <account>', what: 'forget it and delete its saved login' },
			{
				usage: 'disable | enable <service> <account>',
				what: 'skip it when switching, or stop skipping',
			},
			{ usage: 'rename <service> <account> <name>', what: 'give it a short name' },
			{ usage: 'move | swap', what: 'change the order' },
		],
	},
	{
		title: 'Per project',
		entries: [
			{ usage: 'run <service> -- <command>', what: 'run a command on this folder’s account' },
			{ usage: 'map <service> <account> [path]', what: 'tie a folder to an account' },
			{ usage: 'unmap [path]', what: 'remove that rule' },
		],
	},
	{
		title: 'Settings',
		entries: [
			{ usage: 'config', what: 'show every setting' },
			{ usage: 'config set <key> <value>', what: 'change one' },
			{ usage: 'export | import <file>', what: 'move accounts between machines' },
		],
	},
];

export function renderHelp(): string {
	const t = theme();
	const glyphs = symbols(t);
	const width = Math.max(
		...GROUPS.flatMap((group) => group.entries.map((entry) => visibleLength(entry.usage))),
	);

	const lines = [
		'',
		`${bold(t, paint(t, 'accent', 'hotseat'))}  ${dim(t, 'one bench of accounts for Claude Code and Codex')}`,
	];
	for (const group of GROUPS) {
		lines.push('', heading(t, group.title));
		for (const entry of group.entries) {
			lines.push(`  ${paint(t, 'text', pad(entry.usage, width))}  ${dim(t, entry.what)}`);
		}
	}
	lines.push(
		'',
		dim(t, `${glyphs.bullet} a service is claude or codex`),
		dim(t, `${glyphs.bullet} an account is its number, its email, or the name you gave it`),
		'',
	);
	return lines.join('\n');
}
