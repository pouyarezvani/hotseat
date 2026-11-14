import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from '../src/core/fs.ts';
import {
	AntigravityProvider,
	clientsIn,
	decodeKeychain,
	encodeKeychain,
	KEYCHAIN_COMMAND_LIMIT,
	keychainCommand,
	mapUsage,
	planOf,
} from '../src/providers/antigravity/index.ts';
import { withHome } from './helpers.ts';

const realFetch = globalThis.fetch;
// No test looks for the agent installed on this Mac: each names its own, or none.
beforeEach(() => {
	process.env.HOTSEAT_AGY = '/nonexistent/agy';
});
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.HOTSEAT_AGY;
});

/** The answer the service gave for a real account, with the prose trimmed. */
const SUMMARY = {
	groups: [
		{
			displayName: 'Gemini Models',
			buckets: [
				{
					bucketId: 'gemini-weekly',
					window: 'weekly',
					resetTime: '2026-11-20T23:15:56Z',
					remainingFraction: 0.9969339,
				},
				{
					bucketId: 'gemini-5h',
					window: '5h',
					resetTime: '2026-11-14T11:22:23Z',
					remainingFraction: 1,
				},
			],
		},
		{
			displayName: 'Claude and GPT models',
			buckets: [
				{
					bucketId: '3p-weekly',
					window: 'weekly',
					resetTime: '2026-11-21T06:22:23Z',
					remainingFraction: 1,
				},
				{
					bucketId: '3p-5h',
					window: '5h',
					resetTime: '2026-11-14T11:22:23Z',
					remainingFraction: 1,
				},
			],
		},
		{
			displayName: 'Gemini 4 Argon',
			buckets: [
				{
					bucketId: 'gemini-argon-wtu-weekly',
					window: 'weekly',
					resetTime: '2026-11-20T23:15:36Z',
					remainingFraction: 0.95778096,
				},
			],
		},
	],
};

function login(expiry: string): Record<string, unknown> {
	return {
		token: { access_token: 'access-1', refresh_token: 'refresh-1', expiry },
		auth_method: 'consumer',
		id_token_email: 'someone@example.com',
	};
}

type Call = { url: string; headers: Record<string, string>; body: string };

function fakeFetch(answer: (call: Call) => Response): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const call = {
				url: String(input),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: String(init?.body ?? ''),
			};
			calls.push(call);
			return answer(call);
		},
		{ preconnect: () => undefined },
	) as unknown as typeof fetch;
	return calls;
}

const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('reading the limits the service reports', () => {
	const usage = mapUsage(SUMMARY, '2026-11-14T06:22:00Z');

	test('each limit is named for its group and its window, the 5-hour one first', () => {
		expect(usage.windows.map((window) => window.label)).toEqual([
			'Gemini 5h',
			'Gemini week',
			'Claude and GPT 5h',
			'Claude and GPT week',
			'Gemini 4 Argon week',
		]);
	});

	test('each limit says how long it runs, so the weekly ones are held to the weekly threshold', () => {
		expect(usage.windows.map((window) => window.span)).toEqual([
			'5h',
			'week',
			'5h',
			'week',
			'week',
		]);
	});

	test('what is left becomes what is used, to a tenth of a point', () => {
		expect(usage.windows.map((window) => window.percent)).toEqual([0, 0.3, 0, 0, 4.2]);
	});

	test('each limit keeps its own key and reset time', () => {
		expect(usage.windows[1]).toEqual({
			key: 'gemini-weekly',
			label: 'Gemini week',
			percent: 0.3,
			span: 'week',
			resetsAt: '2026-11-20T23:15:56Z',
		});
	});

	test('a limit that comes with no number is left out, not shown as empty or full', () => {
		const partial = mapUsage(
			{ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'x', window: '5h' }] }] },
			'now',
		);
		expect(partial.windows).toEqual([]);
	});

	test('a number outside what a share can be is held to the ends', () => {
		const odd = mapUsage(
			{
				groups: [
					{
						displayName: 'G',
						buckets: [
							{ bucketId: 'a', window: '5h', remainingFraction: 1.4 },
							{ bucketId: 'b', window: 'weekly', remainingFraction: -0.2 },
						],
					},
				],
			},
			'now',
		);
		expect(odd.windows.map((window) => window.percent)).toEqual([0, 100]);
	});

	test('an answer with nothing in it is no limits, not a crash', () => {
		expect(mapUsage({}, 'now').windows).toEqual([]);
	});
});

describe('the plan', () => {
	test('a paid plan is the one named, over the free tier listed beside it', () => {
		expect(
			planOf({ currentTier: { name: 'Antigravity' }, paidTier: { name: 'Google AI Pro' } }),
		).toBe('Google AI Pro');
	});

	test('with no paid plan it is the tier the account is on', () => {
		expect(planOf({ currentTier: { name: 'Antigravity' } })).toBe('Antigravity');
		expect(planOf({})).toBeUndefined();
	});
});

describe('the login the agent keeps', () => {
	test('is read from behind its prefix', () => {
		const stored = `go-keyring-base64:${Buffer.from(JSON.stringify(login('x'))).toString('base64')}\n`;
		expect(decodeKeychain(stored)).toEqual(login('x'));
	});

	test('something that is not a login reads as none', () => {
		expect(decodeKeychain('')).toBeNull();
		expect(decodeKeychain('go-keyring-base64:not-base64-json')).toBeNull();
		expect(decodeKeychain('[1,2]')).toBeNull();
	});

	test('with nothing in the keychain there is no login', async () => {
		expect(await new AntigravityProvider().readAgentCredential()).toBeNull();
	});

	test('names its account from the login itself, with the plan when the service says', async () => {
		fakeFetch(() =>
			json({ currentTier: { name: 'Antigravity' }, paidTier: { name: 'Google AI Pro' } }),
		);
		expect(await new AntigravityProvider().identify(login('2099-01-01T00:00:00Z'))).toEqual({
			email: 'someone@example.com',
			plan: 'Google AI Pro',
		});
	});

	test('still names its account when the service does not answer', async () => {
		fakeFetch(() => json({}, 503));
		expect(await new AntigravityProvider().identify(login('2099-01-01T00:00:00Z'))).toEqual({
			email: 'someone@example.com',
		});
	});
});

describe('asking the service', () => {
	test('a login still good is used as it is, named as Antigravity', async () => {
		const calls = fakeFetch(() => json(SUMMARY));
		const usage = await new AntigravityProvider().fetchUsage(login('2099-01-01T00:00:00Z'));
		expect(usage.windows.length).toBe(5);
		expect(calls.map((call) => call.url)).toEqual([
			'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
		]);
		expect(calls[0]?.headers.authorization).toBe('Bearer access-1');
		expect(calls[0]?.headers['user-agent']).toBe('antigravity/cli/1.5.9');
	});

	test('names the version of the agent installed, which the service reads before it answers in full', async () => {
		await withHome(async (home) => {
			const program = join(home, 'agy');
			await Bun.write(program, '#!/bin/sh\necho 2.3.4\n');
			await chmod(program, 0o755);
			process.env.HOTSEAT_AGY = program;
			const calls = fakeFetch(() => json(SUMMARY));
			const provider = new AntigravityProvider();
			await provider.fetchUsage(login('2099-01-01T00:00:00Z'));
			expect(calls[0]?.headers['user-agent']).toBe('antigravity/cli/2.3.4');
			const kept = await readJson<{ version: { value: string } }>(join(home, 'antigravity.json'));
			expect(kept?.version.value).toBe('2.3.4');
		});
	});

	test('a refusal is reported with its status, so a login that is gone can be told from a busy service', async () => {
		fakeFetch(() => json({}, 403));
		await expect(
			new AntigravityProvider().fetchUsage(login('2099-01-01T00:00:00Z')),
		).rejects.toMatchObject({ status: 403 });
	});
});

describe('a login whose access token has run out', () => {
	const ID_A = '11111111111-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.apps.googleusercontent.com';
	const ID_B = '22222222222-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.apps.googleusercontent.com';
	const SECRET_A = `GOCSPX-${'a'.repeat(28)}`;
	const SECRET_B = `GOCSPX-${'b'.repeat(28)}`;

	async function withProgram<T>(work: (home: string) => Promise<T>): Promise<T> {
		return withHome(async (home) => {
			const program = join(home, 'agy');
			await Bun.write(program, `\0\0${ID_A}\0junk\0${SECRET_A}\0${ID_B}\0${SECRET_B}\0`);
			process.env.HOTSEAT_AGY = program;
			return work(home);
		});
	}

	function service(): Call[] {
		return fakeFetch((call) => {
			if (call.url === 'https://oauth2.googleapis.com/token') {
				const form = new URLSearchParams(call.body);
				const right = form.get('client_id') === ID_B && form.get('client_secret') === SECRET_B;
				return right
					? json({ access_token: 'access-2', expires_in: 3600 })
					: json({ error: 'invalid_client' }, 401);
			}
			return call.headers.authorization === 'Bearer access-2' ? json(SUMMARY) : json({}, 401);
		});
	}

	test('finds every sign-in client the agent carries', () => {
		expect(clientsIn(`x${ID_A}y${SECRET_A}z${ID_B}`)).toEqual([
			{ clientId: ID_A, clientSecret: SECRET_A },
			{ clientId: ID_B, clientSecret: SECRET_A },
		]);
		expect(clientsIn('nothing here')).toEqual([]);
	});

	test('is renewed with the client that issued it, and the reading goes ahead', async () => {
		await withProgram(async () => {
			const calls = service();
			const usage = await new AntigravityProvider().fetchUsage(login('2020-01-01T00:00:00Z'));
			expect(usage.windows.length).toBe(5);
			expect(calls.at(-1)?.headers.authorization).toBe('Bearer access-2');
		});
	});

	test('the renewal and the client that worked are kept, so the next reading asks for neither', async () => {
		await withProgram(async (home) => {
			service();
			const provider = new AntigravityProvider();
			await provider.fetchUsage(login('2020-01-01T00:00:00Z'));
			const kept = await readJson<{ client: { clientId: string }; token: { accessToken: string } }>(
				join(home, 'antigravity.json'),
			);
			expect(kept?.client.clientId).toBe(ID_B);
			expect(kept?.token.accessToken).toBe('access-2');
			const again = service();
			await provider.fetchUsage(login('2020-01-01T00:00:00Z'));
			expect(again.map((call) => call.url)).toEqual([
				'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
			]);
		});
	});

	test('renewing gives the same login a newer key, and keeps the token that renews it', async () => {
		await withProgram(async () => {
			service();
			const provider = new AntigravityProvider();
			const saved = login('2020-01-01T00:00:00Z');
			const renewed = await provider.refreshIfNeeded(saved);
			const token = renewed.token as Record<string, unknown>;
			expect(token.access_token).toBe('access-2');
			expect(token.refresh_token).toBe('refresh-1');
			expect(provider.expiresAt(renewed)).toBeGreaterThan(Date.now());
			expect(renewed.id_token_email).toBe('someone@example.com');
			expect(provider.sharesToken(saved, renewed)).toBe(true);
			expect((saved.token as Record<string, unknown>).access_token).toBe('access-1');
		});
	});

	test('a login still good is not renewed', async () => {
		const calls = fakeFetch(() => json({}));
		const provider = new AntigravityProvider();
		const saved = login('2099-01-01T00:00:00Z');
		expect(await provider.refreshIfNeeded(saved)).toBe(saved);
		expect(calls).toEqual([]);
	});

	test('a login is stored the way Antigravity reads it back', () => {
		const saved = login('2099-01-01T00:00:00Z');
		const stored = encodeKeychain(saved);
		expect(stored.startsWith('go-keyring-base64:')).toBe(true);
		expect(decodeKeychain(stored)).toEqual(saved);
	});

	test('a login too long for one keychain command is refused before anything is written', () => {
		const fits = keychainCommand('ab'.repeat(1900));
		expect(Buffer.byteLength(fits)).toBeLessThanOrEqual(KEYCHAIN_COMMAND_LIMIT);
		expect(fits.endsWith('\n')).toBe(true);
		expect(() => keychainCommand('ab'.repeat(2100))).toThrow('too long to store safely');
	});

	test('a refused keychain write says only its status, never what it was given', async () => {
		const saved = { ...login('2099-01-01T00:00:00Z'), padding: 'x'.repeat(4000) };
		await expect(new AntigravityProvider().writeAgentCredential(saved)).rejects.toThrow(
			'too long to store safely',
		);
	});

	test('says when its login runs out, so it is renewed before then', () => {
		const provider = new AntigravityProvider();
		expect(provider.expiresAt(login('2099-01-01T00:00:00Z'))).toBe(
			Date.parse('2099-01-01T00:00:00Z'),
		);
		expect(provider.expiresAt({ token: { access_token: 'a' } })).toBeUndefined();
	});

	test('a token the service says is spent early is renewed once and asked again', async () => {
		await withProgram(async () => {
			const calls = service();
			const usage = await new AntigravityProvider().fetchUsage(login('2099-01-01T00:00:00Z'));
			expect(usage.windows.length).toBe(5);
			expect(calls[0]?.headers.authorization).toBe('Bearer access-1');
			expect(calls.at(-1)?.headers.authorization).toBe('Bearer access-2');
		});
	});

	test('a sign-in the service has ended reads as a login that no longer works', async () => {
		await withProgram(async () => {
			fakeFetch((call) =>
				call.url === 'https://oauth2.googleapis.com/token'
					? json({ error: 'invalid_grant' }, 400)
					: json({}, 401),
			);
			await expect(
				new AntigravityProvider().fetchUsage(login('2020-01-01T00:00:00Z')),
			).rejects.toThrow('invalid_grant');
		});
	});

	test('with the agent not installed it says to open Antigravity, rather than failing blankly', async () => {
		await withHome(async (home) => {
			process.env.HOTSEAT_AGY = join(home, 'missing');
			fakeFetch(() => json({}, 401));
			await expect(
				new AntigravityProvider().fetchUsage(login('2020-01-01T00:00:00Z')),
			).rejects.toThrow('open Antigravity once');
		});
	});
});
