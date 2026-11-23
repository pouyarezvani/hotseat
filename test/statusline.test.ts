import { describe, expect, test } from 'bun:test';
import { chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { settingsPath, snapshotPath, statePath } from '../src/core/paths.ts';
import {
	installStatusLine,
	type Snapshot,
	STALE_AFTER_MS,
	shellQuote,
	statusLine,
} from '../src/ui/statusline.ts';
import type { Theme } from '../src/ui/style.ts';
import { withHome } from './helpers.ts';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const HOUR = 3_600_000;
const at = (ms: number): string => new Date(ms).toISOString();
const plain = { color: false } as unknown as Theme;

function snapshot(change: (s: Snapshot) => void = () => undefined): Snapshot {
	const s: Snapshot = {
		version: 1,
		updatedAt: at(NOW),
		providers: {
			claude: {
				activeAccountId: 'a',
				accounts: [
					{
						id: 'a',
						provider: 'claude',
						email: 'pouya@example.com',
						slot: 1,
						disabled: false,
						addedAt: at(NOW),
						usage: {
							fetchedAt: at(NOW),
							windows: [
								{ key: 'five_hour', label: '5h', percent: 17.4, resetsAt: at(NOW + 2 * HOUR) },
								{ key: 'seven_day', label: 'week', percent: 4, resetsAt: at(NOW + 70 * HOUR) },
							],
						},
					},
				],
			},
			codex: { accounts: [] },
			antigravity: { accounts: [] },
			grok: { accounts: [] },
		},
	};
	change(s);
	return s;
}

describe("the line for an agent's status bar", () => {
	test('names the account in use and each limit with when it resets', () => {
		expect(statusLine(snapshot(), 'claude', plain, NOW)).toBe(
			'pouya · 5h 17% 2h 0m · week 4% 2d 22h',
		);
	});

	test('says which limit will fill first at this pace', () => {
		const line = statusLine(
			snapshot((s) => {
				const windows = s.providers.claude.accounts[0]?.usage?.windows ?? [];
				if (windows[0]) windows[0].fullAt = at(NOW + HOUR);
				if (windows[1]) windows[1].fullAt = at(NOW + 30 * HOUR);
			}),
			'claude',
			plain,
			NOW,
		);
		expect(line).toEndWith(' · 5h full in 1h 0m');
	});

	test("says the service's own trouble, and nothing when it is fine", () => {
		const fine = snapshot((s) => {
			s.services = {
				claude: {
					level: 'ok',
					summary: 'Claude Code is operational',
					url: 'u',
					checkedAt: at(NOW),
					scoped: true,
				},
			};
		});
		expect(statusLine(fine, 'claude', plain, NOW)).not.toContain('operational');
		const bad = snapshot((s) => {
			s.services = {
				claude: {
					level: 'major',
					summary: 'Claude Code is partial outage: Elevated errors',
					url: 'u',
					checkedAt: at(NOW),
					scoped: true,
				},
			};
		});
		expect(statusLine(bad, 'claude', plain, NOW)).toEndWith(
			' · Claude Code is partial outage: Elevated errors',
		);
	});

	test('a small issue on a page that covers a whole company is left out, and an outage there is not', () => {
		const wide = (level: 'minor' | 'major') =>
			snapshot((s) => {
				s.services = {
					claude: {
						level,
						summary: 'Something at the company',
						url: 'u',
						checkedAt: at(NOW),
						scoped: false,
					},
				};
			});
		expect(statusLine(wide('minor'), 'claude', plain, NOW)).not.toContain('Something');
		expect(statusLine(wide('major'), 'claude', plain, NOW)).toEndWith(
			' · Something at the company',
		);
	});

	test('numbers read a while ago say how long ago', () => {
		const old = snapshot((s) => {
			const usage = s.providers.claude.accounts[0]?.usage;
			if (usage) usage.fetchedAt = at(NOW - STALE_AFTER_MS - 5 * 60_000);
		});
		expect(statusLine(old, 'claude', plain, NOW)).toEndWith(' · read 15m ago');
	});

	test('with no board yet, or no account in use, it says so in a few words', () => {
		expect(statusLine(null, 'claude', plain, NOW)).toBe('hotseat: no reading yet');
		expect(statusLine(snapshot(), 'codex', plain, NOW)).toBe('hotseat: no account in use');
	});

	test('an account that could not be read says why in place of its limits', () => {
		const failed = snapshot((s) => {
			const account = s.providers.claude.accounts[0];
			if (account) account.usage = { fetchedAt: at(NOW), windows: [], error: 'no saved login' };
		});
		expect(statusLine(failed, 'claude', plain, NOW)).toBe('pouya · no saved login');
	});
});

describe('numbers that are old or could not be refreshed', () => {
	test('a failed read is said beside the last good numbers', () => {
		const failed = snapshot((s) => {
			const usage = s.providers.claude.accounts[0]?.usage;
			if (usage) usage.error = 'the saved login no longer works';
		});
		expect(statusLine(failed, 'claude', plain, NOW)).toEndWith(
			' · last read failed: the saved login no longer works',
		);
	});

	test('age is counted from when the account was read, not from when the board was worked out', () => {
		const old = snapshot((s) => {
			const usage = s.providers.claude.accounts[0]?.usage;
			if (usage) usage.fetchedAt = at(NOW - 2 * HOUR);
		});
		expect(statusLine(old, 'claude', plain, NOW)).toEndWith(' · read 2h 0m ago');
	});

	test('a limit left off the board is left off the line too', () => {
		const hidden = snapshot((s) => {
			const window = s.providers.claude.accounts[0]?.usage?.windows[1];
			if (window) window.hidden = true;
		});
		expect(statusLine(hidden, 'claude', plain, NOW)).toBe('pouya · 5h 17% 2h 0m');
	});
});

describe('putting the line in Claude Code', () => {
	test('a settings file that cannot be read still leaves the line drawn from the board', async () => {
		await withHome(async (home) => {
			await Bun.write(snapshotPath(), JSON.stringify(snapshot()));
			await Bun.write(settingsPath(), '{ not json');
			const child = Bun.spawn(
				[process.execPath, join(import.meta.dir, '../bin/hotseat.ts'), 'statusline'],
				{
					env: { ...process.env, HOTSEAT_HOME: home, HOME: home, NO_COLOR: '1' },
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const out = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			expect(out).toContain('week 4%');
		});
	});

	test('the account in use is the one the menu published last, when that is newer', async () => {
		await withHome(async (home) => {
			await Bun.write(snapshotPath(), JSON.stringify(snapshot()));
			const published = snapshot((s) => {
				s.updatedAt = at(NOW + HOUR);
				s.providers.claude.activeAccountId = 'b';
				s.providers.claude.accounts.push({
					id: 'b',
					provider: 'claude',
					email: 'other@example.com',
					slot: 2,
					disabled: false,
					addedAt: at(NOW),
					usage: {
						fetchedAt: at(NOW + HOUR),
						windows: [{ key: 'seven_day', label: 'week', percent: 55 }],
					},
				});
			});
			await Bun.write(statePath(), JSON.stringify(published));
			const child = Bun.spawn(
				[process.execPath, join(import.meta.dir, '../bin/hotseat.ts'), 'statusline'],
				{
					env: { ...process.env, HOTSEAT_HOME: home, HOME: home, NO_COLOR: '1' },
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const out = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			expect(out).toContain('other');
			expect(out).toContain('week 55%');
		});
	});

	async function drawn(home: string): Promise<string> {
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, '../bin/hotseat.ts'), 'statusline'],
			{
				env: { ...process.env, HOTSEAT_HOME: home, HOME: home, NO_COLOR: '1' },
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const out = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		return out;
	}

	const publishedB = () =>
		snapshot((s) => {
			s.updatedAt = at(NOW + HOUR);
			s.providers.claude.activeAccountId = 'b';
			s.providers.claude.accounts.push({
				id: 'b',
				provider: 'claude',
				email: 'other@example.com',
				slot: 2,
				disabled: false,
				addedAt: at(NOW),
				usage: {
					fetchedAt: at(NOW + HOUR),
					windows: [
						{ key: 'five_hour', label: '5h', percent: 20 },
						{ key: 'seven_day', label: 'week', percent: 55 },
					],
				},
			});
		});

	test('limits asked to be left off stay off when the published board is newer', async () => {
		await withHome(async (home) => {
			await Bun.write(snapshotPath(), JSON.stringify(snapshot()));
			await Bun.write(statePath(), JSON.stringify(publishedB()));
			await Bun.write(settingsPath(), JSON.stringify({ version: 1, hideLimits: ['week'] }));
			const out = await drawn(home);
			expect(out).toContain('other');
			expect(out).toContain('5h 20%');
			expect(out).not.toContain('week');
		});
	});

	test('without settings, the line is the saved one as it was drawn', async () => {
		await withHome(async (home) => {
			await Bun.write(
				snapshotPath(),
				JSON.stringify(
					snapshot((s) => {
						const windows = s.providers.claude.accounts[0]?.usage?.windows ?? [];
						for (const window of windows) if (window.label === 'week') window.hidden = true;
					}),
				),
			);
			await Bun.write(statePath(), JSON.stringify(publishedB()));
			await Bun.write(settingsPath(), '{ not json');
			const out = await drawn(home);
			expect(out).toContain('pouya');
			expect(out).not.toContain('other');
			expect(out).not.toContain('week');
		});
	});

	test('a newer published board with the same reading keeps the saved forecast', async () => {
		await withHome(async (home) => {
			const now = Date.now();
			const board = (updatedAt: number, fullAt?: string) =>
				snapshot((s) => {
					s.updatedAt = at(updatedAt);
					const usage = s.providers.claude.accounts[0]?.usage;
					if (!usage) return;
					usage.fetchedAt = at(now - 60_000);
					usage.windows = [
						{
							key: 'seven_day',
							label: 'week',
							percent: 50,
							resetsAt: at(now + 5 * HOUR),
							...(fullAt ? { fullAt } : {}),
						},
					];
				});
			await Bun.write(snapshotPath(), JSON.stringify(board(now - 60_000, at(now + 31 * 60_000))));
			await Bun.write(statePath(), JSON.stringify(board(now)));
			const out = await drawn(home);
			expect(out).toContain('full in');
		});
	});

	test('a limit saved as hidden is shown again once it is no longer asked to be left off', async () => {
		await withHome(async (home) => {
			await Bun.write(
				snapshotPath(),
				JSON.stringify(
					snapshot((s) => {
						const windows = s.providers.claude.accounts[0]?.usage?.windows ?? [];
						for (const window of windows) if (window.label === 'week') window.hidden = true;
					}),
				),
			);
			await Bun.write(settingsPath(), JSON.stringify({ version: 1, hideLimits: [] }));
			const out = await drawn(home);
			expect(out).toContain('week');
		});
	});

	test('a settings file keeps the permissions it had, and its other settings', async () => {
		await withHome(async (home) => {
			const path = join(home, 'settings.json');
			await Bun.write(path, JSON.stringify({ env: { TOKEN: 'secret' } }));
			await chmod(path, 0o600);
			expect(await installStatusLine(path, ['/usr/local/bin/hotseat'])).toBe('installed');
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(await Bun.file(path).json()).toEqual({
				env: { TOKEN: 'secret' },
				statusLine: { type: 'command', command: '/usr/local/bin/hotseat statusline' },
			});
		});
	});

	test('a settings file that did not exist is made private', async () => {
		await withHome(async (home) => {
			const path = join(home, 'settings.json');
			await installStatusLine(path, ['/usr/local/bin/hotseat']);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		});
	});

	test('a status line already set is left alone', async () => {
		await withHome(async (home) => {
			const path = join(home, 'settings.json');
			const before = JSON.stringify({ statusLine: { type: 'command', command: 'mine' } });
			await Bun.write(path, before);
			expect(await installStatusLine(path, ['/usr/local/bin/hotseat'])).toBe('taken');
			expect(await Bun.file(path).text()).toBe(before);
		});
	});

	test('a path with a space or a quote in it stays one word of the command', async () => {
		await withHome(async (home) => {
			const path = join(home, 'settings.json');
			await installStatusLine(path, ["/Tools With Spaces/it's/bun", '/src/hot seat/bin.ts']);
			const saved = (await Bun.file(path).json()) as { statusLine: { command: string } };
			expect(saved.statusLine.command).toBe(
				"'/Tools With Spaces/it'\\''s/bun' '/src/hot seat/bin.ts' statusline",
			);
		});
	});

	test('plain words are left as they are', () => {
		expect(shellQuote('/usr/local/bin/hotseat')).toBe('/usr/local/bin/hotseat');
		expect(shellQuote('')).toBe("''");
	});
});
