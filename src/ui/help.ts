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
			{
				usage: 'best <service>',
				what: 'switch now, to the account that resets soonest with room left',
			},
			{ usage: 'rotate <service>', what: 'switch to the next in order' },
			{ usage: 'next <service>', what: 'switch to the next with room' },
			{ usage: 'auto', what: 'run the switching loop in this terminal instead of the menu bar' },
		],
	},
	{
		title: 'Accounts',
		entries: [
			{ usage: 'add', what: 'sign in to another account and add it' },
			{ usage: 'add <service>', what: 'add the account signed in right now' },
			{
				usage: 'signin <service> <account>',
				what: 'sign in to it again, when its login stops working',
			},
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
		title: 'One terminal, another account',
		entries: [
			{
				usage: 'run <service> [account]',
				what: 'open the agent as that account in this terminal only',
			},
			{ usage: 'run <service> [account] -- <command>', what: 'or run any command that way' },
			{ usage: 'map <service> <account> [path]', what: 'tie a folder to an account' },
			{ usage: 'unmap [path]', what: 'remove that rule' },
		],
	},
	{
		title: 'Menu bar',
		entries: [
			{ usage: 'menubar', what: 'open the menu bar app' },
			{ usage: 'menubar install', what: 'and start it whenever you log in' },
			{ usage: 'menubar stop | uninstall', what: 'close it, or stop it starting at login' },
			{ usage: 'menubar status', what: 'is it running, is it set to start at login' },
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
		`${bold(t, paint(t, 'accent', 'hotseat'))}  ${dim(t, 'several Claude Code and Codex accounts, one in use at a time')}`,
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
