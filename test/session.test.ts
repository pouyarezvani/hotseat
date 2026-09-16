import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateRegistry, upsertAccount } from '../src/core/registry.ts';
import {
	captureSession,
	forgetSession,
	freshestLogin,
	needsSession,
	prepareSession,
	sessionDir,
} from '../src/core/session.ts';
import { activate } from '../src/core/switch.ts';
import type { AccountRecord } from '../src/core/types.ts';
import { loadCredential, storeCredential } from '../src/core/vault.ts';
import { seedClaudeConfig, updateOauthAccount } from '../src/providers/claude/session.ts';
import { cred, type FakeProvider, fakeProviders } from './fake-provider.ts';
import { withHome } from './helpers.ts';

async function world(
	home: string,
): Promise<{ claude: FakeProvider; a: AccountRecord; b: AccountRecord }> {
	const { claude } = fakeProviders();
	claude.home = join(home, 'agent-home');
	await mkdir(join(claude.home, 'skills'), { recursive: true });
	await writeFile(join(claude.home, 'settings.json'), '{"theme":"dark"}');
	await writeFile(join(claude.home, 'history.jsonl'), 'private');
	const a = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
	);
	const b = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
	);
	await storeCredential(a, cred('A', 100));
	await storeCredential(b, cred('B', 100));
	claude.identities.set('A', { email: 'a@example.com' });
	claude.identities.set('B', { email: 'b@example.com' });
	claude.installed = cred('A', 100);
	return { claude, a, b };
}

describe('running one terminal as another account', () => {
	test('points the agent at a folder of its own, with the shared setup linked in and its login placed', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const session = await prepareSession(claude, b);
			expect(session.dir).toBe(join(home, 'sessions', 'claude', 'b@example.com'));
			expect(session.env).toEqual({ CLAUDE_HOME: session.dir });
			expect(await readlink(join(session.dir, 'settings.json'))).toBe(
				await realpath(join(claude.home, 'settings.json')),
			);
			expect(await readlink(join(session.dir, 'skills'))).toBe(
				await realpath(join(claude.home, 'skills')),
			);
			await expect(lstat(join(session.dir, 'history.jsonl'))).rejects.toThrow();
			expect(await claude.session.readLogin(session.dir)).toEqual(cred('B', 100));
			expect(claude.seeded).toEqual([session.dir]);
			expect((await lstat(session.dir)).mode & 0o777).toBe(0o700);
		});
	});

	test('the same account gets the same folder again, so its history stays with it', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const first = await prepareSession(claude, b);
			await writeFile(join(first.dir, 'history.jsonl'), 'a chat');
			await writeFile(join(claude.home, 'CLAUDE.md'), 'added later');
			claude.session = {
				...claude.session,
				sharedEntries: ['settings.json', 'skills', 'CLAUDE.md'],
			};
			const second = await prepareSession(claude, b);
			expect(second.dir).toBe(first.dir);
			expect(await Bun.file(join(second.dir, 'history.jsonl')).text()).toBe('a chat');
			expect(await readlink(join(second.dir, 'CLAUDE.md'))).toBe(
				await realpath(join(claude.home, 'CLAUDE.md')),
			);
		});
	});

	test('a login the session refreshed is saved when the command ends', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const session = await prepareSession(claude, b);
			await claude.session.writeLogin(session.dir, cred('B-newer', 200));
			claude.identities.set('B-newer', { email: 'b@example.com' });
			expect(await captureSession(claude, b)).toBe(true);
			expect(await loadCredential(b)).toEqual(cred('B-newer', 200));
			expect(await captureSession(claude, b)).toBe(false);
		});
	});

	test('a login older than the saved one is not saved over it, and the saved one is placed instead', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const dir = sessionDir(claude, b);
			await mkdir(dir, { recursive: true });
			await claude.session.writeLogin(dir, cred('B-stale', 50));
			await prepareSession(claude, b);
			expect(await loadCredential(b)).toEqual(cred('B', 100));
			expect(await claude.session.readLogin(dir)).toEqual(cred('B', 100));
		});
	});

	test('a switch installs the freshest copy, even one a session rotated', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const session = await prepareSession(claude, b);
			await claude.session.writeLogin(session.dir, cred('B-rotated', 300));
			claude.identities.set('B-rotated', { email: 'b@example.com' });
			await activate('claude', b.id, { providers: { claude, codex: fakeProviders().codex } });
			expect(claude.installed).toEqual(cred('B-rotated', 300));
			expect(await loadCredential(b)).toEqual(cred('B-rotated', 300));
		});
	});

	test('an account with no saved login cannot be run', async () => {
		await withHome(async (home) => {
			const { claude } = await world(home);
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await expect(prepareSession(claude, c)).rejects.toThrow(/no saved login for c@example.com/);
		});
	});

	test('the account already in use needs no session', () => {
		const state = { activeAccountId: 'a', accounts: [] };
		expect(needsSession(state, 'a')).toBe(false);
		expect(needsSession(state, 'b')).toBe(true);
		expect(needsSession({ accounts: [] }, 'a')).toBe(true);
	});

	test('freshest login prefers whichever copy was issued later', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			expect(await freshestLogin(claude, b)).toEqual(cred('B', 100));
			const dir = sessionDir(claude, b);
			await mkdir(dir, { recursive: true });
			await claude.session.writeLogin(dir, cred('B2', 150));
			claude.identities.set('B2', { email: 'b@example.com' });
			expect(await freshestLogin(claude, b)).toEqual(cred('B2', 150));
		});
	});
});

describe("a Claude session's own config file", () => {
	test('is seeded so Claude Code skips first-run questions and sees the MCP servers', async () => {
		await withHome(async (home) => {
			const main = join(home, 'main.claude.json');
			await writeFile(
				main,
				JSON.stringify({
					theme: 'light',
					mcpServers: { x: { url: 'https://x' } },
					oauthAccount: { emailAddress: 'main@example.com' },
				}),
			);
			const dir = join(home, 'session');
			await mkdir(dir);
			await seedClaudeConfig(dir, main);
			const seeded = await Bun.file(join(dir, '.claude.json')).json();
			expect(seeded).toEqual({
				hasCompletedOnboarding: true,
				theme: 'light',
				mcpServers: { x: { url: 'https://x' } },
			});
			expect((await lstat(join(dir, '.claude.json'))).mode & 0o777).toBe(0o600);
		});
	});

	test('keeps what the session wrote and refreshes the MCP servers each time', async () => {
		await withHome(async (home) => {
			const main = join(home, 'main.claude.json');
			await writeFile(main, JSON.stringify({ mcpServers: { y: {} } }));
			const dir = join(home, 'session');
			await mkdir(dir);
			await writeFile(
				join(dir, '.claude.json'),
				JSON.stringify({
					theme: 'dark',
					oauthAccount: { emailAddress: 'b@example.com' },
					mcpServers: { old: {} },
				}),
			);
			await seedClaudeConfig(dir, main);
			const seeded = await Bun.file(join(dir, '.claude.json')).json();
			expect(seeded).toEqual({
				theme: 'dark',
				oauthAccount: { emailAddress: 'b@example.com' },
				mcpServers: { y: {} },
				hasCompletedOnboarding: true,
			});
		});
	});

	test('works with no everyday config file at all', async () => {
		await withHome(async (home) => {
			const dir = join(home, 'session');
			await mkdir(dir);
			await seedClaudeConfig(dir, join(home, 'missing.json'));
			expect(await Bun.file(join(dir, '.claude.json')).json()).toEqual({
				hasCompletedOnboarding: true,
				theme: 'dark',
			});
		});
	});
});

describe('keeping sessions honest', () => {
	test('a session login that belongs to someone else is not adopted', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const dir = sessionDir(claude, b);
			await mkdir(dir, { recursive: true });
			await claude.session.writeLogin(dir, cred('C', 999));
			claude.identities.set('C', { email: 'c@example.com' });
			expect(await freshestLogin(claude, b)).toEqual(cred('B', 100));
			expect(await loadCredential(b)).toEqual(cred('B', 100));
		});
	});

	test('a session login is adopted only once the service confirms whose it is', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const dir = sessionDir(claude, b);
			await mkdir(dir, { recursive: true });
			await claude.session.writeLogin(dir, cred('B-rotated', 500));
			claude.identifyFails = true;
			expect(await freshestLogin(claude, b)).toEqual(cred('B', 100));
			claude.identifyFails = false;
			claude.identities.set('B-rotated', { email: 'b@example.com' });
			expect(await freshestLogin(claude, b)).toEqual(cred('B-rotated', 500));
		});
	});

	test('shared setup links point at the real file, not at a link to a link', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const real = join(home, 'dotfiles-settings.json');
			await writeFile(real, '{}');
			await Bun.write(join(claude.home, 'settings.json'), '');
			await symlink(real, `${join(claude.home, 'settings.json')}.link`);
			claude.session = { ...claude.session, sharedEntries: ['settings.json.link'] };
			const session = await prepareSession(claude, b);
			expect(await readlink(join(session.dir, 'settings.json.link'))).toBe(await realpath(real));
		});
	});

	test('forgetting an account removes its session folder and whatever login it held', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const session = await prepareSession(claude, b);
			await forgetSession(claude, b);
			expect(claude.forgotten).toEqual([session.dir]);
			await expect(lstat(session.dir)).rejects.toThrow();
		});
	});

	test('an account open in another terminal is not forgotten out from under it', async () => {
		await withHome(async (home) => {
			const { claude, b } = await world(home);
			const session = await prepareSession(claude, b);
			claude.runningIn.add(session.dir);
			await expect(forgetSession(claude, b)).rejects.toThrow(/open in another terminal/);
		});
	});
});

describe("Claude Code's own record of who is signed in", () => {
	test('is rewritten after a switch, keeping everything else in the file', async () => {
		await withHome(async (home) => {
			const path = join(home, 'claude.json');
			await writeFile(
				path,
				JSON.stringify({
					theme: 'dark',
					oauthAccount: {
						emailAddress: 'old@example.com',
						organizationUuid: 'org-old',
						accountUuid: 'acc-old',
						organizationRole: 'admin',
					},
				}),
			);
			await updateOauthAccount(path, {
				email: 'new@example.com',
				organizationId: 'org-new',
				accountId: 'acc-new',
				organizationName: 'New Org',
			});
			expect(await Bun.file(path).json()).toEqual({
				theme: 'dark',
				oauthAccount: {
					emailAddress: 'new@example.com',
					organizationUuid: 'org-new',
					accountUuid: 'acc-new',
					organizationName: 'New Org',
					organizationRole: 'admin',
				},
			});
		});
	});

	test('a torn file is treated as empty rather than a crash', async () => {
		await withHome(async (home) => {
			const path = join(home, 'claude.json');
			await writeFile(path, '{"theme": "da');
			await updateOauthAccount(path, { email: 'new@example.com' });
			expect(await Bun.file(path).json()).toEqual({
				oauthAccount: { emailAddress: 'new@example.com' },
			});
			const dir = join(home, 'session');
			await mkdir(dir);
			await seedClaudeConfig(dir, path);
			expect(await Bun.file(join(dir, '.claude.json')).json()).toEqual({
				hasCompletedOnboarding: true,
				theme: 'dark',
			});
		});
	});
});
