import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceError } from '../src/core/errors.ts';
import { ClaudeProvider, localReadingFrom } from '../src/providers/claude/index.ts';
import { claudeSession } from '../src/providers/claude/session.ts';
import { claudeSessions } from '../src/providers/claude/sessions.ts';
import { CodexProvider, codexSession, windowLabel } from '../src/providers/codex/index.ts';
import { clearRunMark, markRunning } from '../src/providers/process.ts';

describe('how Codex windows are named', () => {
	test.each([
		[18_000, '5h'],
		[604_800, 'week'],
		[172_800, '2d'],
		[1_800, '30m'],
		[600, '10m'],
		[null, 'limit'],
		[undefined, 'limit'],
		[0, 'limit'],
	])('%s seconds is "%s"', (seconds, label) => {
		expect(windowLabel(seconds)).toBe(label);
	});
});

describe('refreshing a Claude login', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test('keeps every field the sign-in granted, including its scopes', async () => {
		const answer = async (): Promise<Response> =>
			new Response(
				JSON.stringify({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		globalThis.fetch = Object.assign(answer, {
			preconnect: () => undefined,
		}) as unknown as typeof fetch;
		const provider = new ClaudeProvider();
		const before = {
			claudeAiOauth: {
				accessToken: 'old',
				refreshToken: 'old-refresh',
				expiresAt: Date.now() - 1000,
				scopes: [
					'user:profile',
					'user:inference',
					'user:sessions:claude_code',
					'user:mcp_servers',
					'user:file_upload',
				],
				subscriptionType: 'max',
				rateLimitTier: 'default_claude_max_20x',
				refreshTokenExpiresAt: 1_900_000_000_000,
			},
			trustedDeviceToken: 'device',
		};
		const after = await provider.refreshIfNeeded(before);
		const oauth = after.claudeAiOauth as Record<string, unknown>;
		expect(oauth.accessToken).toBe('new');
		expect(oauth.refreshToken).toBe('new-refresh');
		expect(oauth.scopes).toEqual(before.claudeAiOauth.scopes);
		expect(oauth.rateLimitTier).toBe('default_claude_max_20x');
		expect(oauth.refreshTokenExpiresAt).toBe(1_900_000_000_000);
		expect(after.trustedDeviceToken).toBe('device');
	});
});

describe('waiting on the keychain', () => {
	test('a call that does not come back in time is cut off and named', async () => {
		const { settleWithin } = await import('../src/providers/claude/keychain.ts');
		const slow = Bun.spawn(['/bin/sleep', '5'], { stdout: 'ignore', stderr: 'ignore' });
		const started = Date.now();
		await expect(settleWithin(slow, 100, 'the keychain')).rejects.toThrow(
			/the keychain did not answer within 0.1s/,
		);
		await slow.exited;
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test('a call that comes back in time is left alone', async () => {
		const { settleWithin } = await import('../src/providers/claude/keychain.ts');
		const quick = Bun.spawn(['/usr/bin/true'], { stdout: 'ignore', stderr: 'ignore' });
		expect(await settleWithin(quick, 2000, 'the keychain')).toBe(0);
	});
});

describe("Claude Code's own cached reading", () => {
	test('is read from its config file with the account it belongs to', () => {
		const reading = localReadingFrom({
			cachedUsageUtilization: {
				fetchedAtMs: 1_789_603_209_730,
				accountUuid: 'acc-1',
				utilization: {
					five_hour: { utilization: 99, resets_at: '2026-09-17T01:30:00.652046+00:00' },
					seven_day: { utilization: 23, resets_at: '2026-09-22T05:00:00.652066+00:00' },
					seven_day_opus: null,
					nimbus_quill: { utilization: 0, resets_at: null },
				},
			},
		});
		expect(reading).toEqual({
			accountId: 'acc-1',
			fetchedAtMs: 1_789_603_209_730,
			windows: [
				{
					key: 'five_hour',
					label: '5h',
					percent: 99,
					resetsAt: '2026-09-17T01:30:00.652046+00:00',
				},
				{
					key: 'seven_day',
					label: 'week',
					percent: 23,
					resetsAt: '2026-09-22T05:00:00.652066+00:00',
				},
			],
		});
	});

	test('is nothing when the file has no such entry, or a torn one', () => {
		expect(localReadingFrom({})).toBeNull();
		expect(localReadingFrom({ cachedUsageUtilization: { fetchedAtMs: 'x' } })).toBeNull();
		expect(
			localReadingFrom({
				cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'a', utilization: {} },
			}),
		).toBeNull();
	});
});

describe('telling which copy of a Claude login is newer', () => {
	const DAY = 86_400_000;
	const at = Date.parse('2026-09-28T09:00:00Z');
	function login(expiresAt: number, refreshTokenExpiresAt: number): Record<string, unknown> {
		return {
			claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt, refreshTokenExpiresAt },
		};
	}

	test("the copy Claude Code renewed last is newer, though its sign-in's end moved a second earlier", () => {
		const saved = login(at - 2 * DAY, at + 23 * DAY + 1000);
		const renewedByAgent = login(at + 8 * 3_600_000, at + 23 * DAY);
		expect(claudeSession.compareAge(renewedByAgent, saved)).toBeGreaterThan(0);
		expect(claudeSession.compareAge(saved, renewedByAgent)).toBeLessThan(0);
	});

	test('a later sign-in is newer than an older one renewed more recently', () => {
		const olderSignInRenewed = login(at + 8 * 3_600_000, at + 10 * DAY);
		const laterSignIn = login(at + 3_600_000, at + 30 * DAY);
		expect(claudeSession.compareAge(laterSignIn, olderSignInRenewed)).toBeGreaterThan(0);
	});

	test('the same copy is the same age', () => {
		expect(claudeSession.compareAge(login(at, at + DAY), login(at, at + DAY))).toBe(0);
	});
});

describe('finding running Claude sessions', () => {
	test('a session file that cannot be read does not hide the others', async () => {
		const home = await mkdtemp(join(tmpdir(), 'hotseat-claude-home-'));
		try {
			await mkdir(join(home, 'sessions'));
			await writeFile(
				join(home, 'sessions', 'live.json'),
				JSON.stringify({ pid: process.pid, cwd: '/work/project', entrypoint: 'cli' }),
			);
			await writeFile(join(home, 'sessions', 'half-written.json'), '{"pid": 1');
			expect(await claudeSessions(home)).toEqual([
				{ pid: process.pid, command: 'terminal in project' },
			]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test('a sessions folder that cannot be read is not taken for no sessions', async () => {
		const home = await mkdtemp(join(tmpdir(), 'hotseat-claude-home-'));
		try {
			await mkdir(join(home, 'sessions'));
			await chmod(join(home, 'sessions'), 0o000);
			await expect(claudeSessions(home)).rejects.toThrow('EACCES');
			await expect(claudeSession.isRunning(home)).rejects.toThrow('EACCES');
		} finally {
			await chmod(join(home, 'sessions'), 0o700);
			await rm(home, { recursive: true, force: true });
		}
	});

	test('a session file that cannot be opened is not taken for no session', async () => {
		const home = await mkdtemp(join(tmpdir(), 'hotseat-claude-home-'));
		try {
			await mkdir(join(home, 'sessions'));
			await writeFile(join(home, 'sessions', 'locked.json'), JSON.stringify({ pid: process.pid }));
			await chmod(join(home, 'sessions', 'locked.json'), 0o000);
			await expect(claudeSessions(home)).rejects.toThrow('EACCES');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe('a Codex session run by hotseat', () => {
	test('is running while the agent hotseat started in it is alive, and not once it ends', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		const agent = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
		try {
			expect(await codexSession.isRunning(dir)).toBe(false);
			await markRunning(dir, agent.pid);
			expect(await codexSession.isRunning(dir)).toBe(true);
			agent.kill('SIGKILL');
			await agent.exited;
			expect(await codexSession.isRunning(dir)).toBe(false);
		} finally {
			agent.kill('SIGKILL');
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a record left by an agent whose process number was given to another is not running', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		try {
			await mkdir(join(dir, 'hotseat-runs'));
			await writeFile(
				join(dir, 'hotseat-runs', `${process.pid}.json`),
				JSON.stringify({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' }),
			);
			expect(await codexSession.isRunning(dir)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a run folder that cannot be read is not taken for idle', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		try {
			await markRunning(dir, process.pid);
			await chmod(join(dir, 'hotseat-runs'), 0o000);
			await expect(codexSession.isRunning(dir)).rejects.toThrow('EACCES');
		} finally {
			await chmod(join(dir, 'hotseat-runs'), 0o700);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a run record that cannot be read is not taken for idle', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		try {
			await markRunning(dir, process.pid);
			await chmod(join(dir, 'hotseat-runs', `${process.pid}.json`), 0o000);
			await expect(codexSession.isRunning(dir)).rejects.toThrow('EACCES');
			await chmod(join(dir, 'hotseat-runs', `${process.pid}.json`), 0o600);
			await writeFile(join(dir, 'hotseat-runs', `${process.pid}.json`), '{"pid": ');
			await expect(codexSession.isRunning(dir)).rejects.toThrow(`${process.pid}.json`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a record still being written is not read as one', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		try {
			await mkdir(join(dir, 'hotseat-runs'));
			await writeFile(join(dir, 'hotseat-runs', '123.json.123.0f3e.tmp'), '{"pid": 1');
			expect(await codexSession.isRunning(dir)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a process that cannot be recorded is refused, rather than left looking idle', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		try {
			await expect(markRunning(dir, 999_999)).rejects.toThrow('could not record process 999999');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('the record is removed when the run ends', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		try {
			await markRunning(dir, process.pid);
			expect(await codexSession.isRunning(dir)).toBe(true);
			await clearRunMark(dir, process.pid);
			expect(await codexSession.isRunning(dir)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('two terminals running as one account are tracked apart, so one ending leaves the other running', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hotseat-codex-session-'));
		const first = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
		const second = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
		try {
			await markRunning(dir, first.pid);
			await markRunning(dir, second.pid);
			first.kill('SIGKILL');
			await first.exited;
			await clearRunMark(dir, first.pid);
			expect(await codexSession.isRunning(dir)).toBe(true);
		} finally {
			first.kill('SIGKILL');
			second.kill('SIGKILL');
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/** A token shaped like the ones Codex is given, saying when it expires. */
function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

function codexLogin(expiresAtMs: number, lastRefresh: number): Record<string, unknown> {
	return {
		tokens: {
			access_token: jwt({ exp: Math.floor(expiresAtMs / 1000) }),
			refresh_token: 'refresh',
			account_id: 'acct',
		},
		last_refresh: new Date(lastRefresh).toISOString(),
	};
}

describe('a Codex login', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function answer(status: number, body: unknown, headers: Record<string, string> = {}): string[] {
		const asked: string[] = [];
		const respond = async (url: string | URL | Request): Promise<Response> => {
			asked.push(String(url));
			return new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json', ...headers },
			});
		};
		globalThis.fetch = Object.assign(respond, {
			preconnect: () => undefined,
		}) as unknown as typeof fetch;
		return asked;
	}

	test('says when its access token expires', () => {
		const at = Date.parse('2026-10-30T12:00:00Z');
		expect(new CodexProvider().expiresAt(codexLogin(at, Date.now()))).toBe(at);
		expect(new CodexProvider().expiresAt({ tokens: { access_token: 'opaque' } })).toBeUndefined();
	});

	test('is renewed once its access token has expired, however recently it was last renewed', async () => {
		const asked = answer(200, { access_token: 'fresh', refresh_token: 'refresh-2' });
		const renewed = await new CodexProvider().refreshIfNeeded(
			codexLogin(Date.now() - 60_000, Date.now() - 60 * 60_000),
		);
		expect(asked).toEqual(['https://auth.openai.com/oauth/token']);
		expect((renewed.tokens as Record<string, unknown>).access_token).toBe('fresh');
	});

	test('a usage request the service turns away says why, and how long to wait', async () => {
		answer(429, { error: 'slow down' }, { 'retry-after': '3600' });
		const login = codexLogin(Date.now() + 3_600_000, Date.now());
		const failure = await new CodexProvider().fetchUsage(login).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ServiceError);
		expect((failure as ServiceError).status).toBe(429);
		expect((failure as ServiceError).retryAfterMs).toBe(3_600_000);
	});

	test('a usage request refused for its login says so, so the failure is counted', async () => {
		answer(401, { error: 'unauthorized' });
		const login = codexLogin(Date.now() + 3_600_000, Date.now());
		const failure = await new CodexProvider().fetchUsage(login).catch((error: unknown) => error);
		expect((failure as ServiceError).status).toBe(401);
	});
});

describe('the real Codex provider, read by the collector', () => {
	const realFetch = globalThis.fetch;
	const savedHome = process.env.CODEX_HOME;
	afterEach(() => {
		globalThis.fetch = realFetch;
		if (savedHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = savedHome;
	});

	test('a refused read is counted as a refused login, and a busy service is waited out', async () => {
		const { collectState } = await import('../src/core/collect.ts');
		const { updateRegistry, upsertAccount } = await import('../src/core/registry.ts');
		const { storeCredential } = await import('../src/core/vault.ts');
		const { fakeProviders } = await import('./fake-provider.ts');
		const { withHome } = await import('./helpers.ts');
		await withHome(async (home) => {
			process.env.CODEX_HOME = join(home, 'codex');
			const one = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'codex', email: 'one@example.com' }),
			);
			const two = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'codex', email: 'two@example.com' }),
			);
			const login = (refresh: string): Record<string, unknown> => ({
				...codexLogin(Date.now() + 3_600_000, Date.now()),
				tokens: {
					access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
					refresh_token: refresh,
					account_id: refresh,
				},
			});
			await storeCredential(one, login('one'));
			await storeCredential(two, login('two'));
			globalThis.fetch = Object.assign(
				async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
					const account = new Headers(init?.headers).get('chatgpt-account-id');
					return account === 'one'
						? new Response('{}', { status: 401 })
						: new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
				},
				{ preconnect: () => undefined },
			) as unknown as typeof fetch;
			const providers = { claude: fakeProviders().claude, codex: new CodexProvider() };
			const now = Date.now();
			const state = await collectState({ providers, now, force: true, awake: async () => true });
			const byEmail = new Map(
				state.providers.codex.accounts.map((account) => [account.email, account.usage]),
			);
			expect(byEmail.get('one@example.com')).toMatchObject({ errorKind: 'auth', failedReads: 1 });
			expect(byEmail.get('two@example.com')).toMatchObject({
				errorKind: 'throttled',
				retryAt: new Date(now + 3_600_000).toISOString(),
			});
		});
	});
});
