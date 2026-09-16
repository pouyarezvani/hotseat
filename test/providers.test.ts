import { afterEach, describe, expect, test } from 'bun:test';
import { ClaudeProvider } from '../src/providers/claude/index.ts';
import { windowLabel } from '../src/providers/codex/index.ts';

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
