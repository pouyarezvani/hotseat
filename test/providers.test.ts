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
