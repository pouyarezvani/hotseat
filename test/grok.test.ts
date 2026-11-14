import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { GrokProvider, loginIn, mapBilling } from '../src/providers/grok/index.ts';
import { withHome } from './helpers.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.GROK_HOME;
});

function login(expiresAt: string): Record<string, unknown> {
	return {
		key: 'access-1',
		refresh_token: 'refresh-1',
		expires_at: expiresAt,
		email: 'someone@example.com',
		oidc_issuer: 'https://auth.x.ai',
		oidc_client_id: 'client-1',
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

/** What the service answered for a real account that had used nothing. */
const NOTHING_REPORTED = {
	config: {
		monthlyLimit: { val: 0 },
		used: { val: 0 },
		onDemandCap: { val: 0 },
		billingPeriodStart: '2026-11-01T00:00:00+00:00',
		billingPeriodEnd: '2026-12-01T00:00:00+00:00',
		history: [],
	},
};

describe('reading what the plan has used', () => {
	test('an account the service reports no allowance for has no limit to draw, and says so', () => {
		const usage = mapBilling(NOTHING_REPORTED, 'now');
		expect(usage.windows).toEqual([]);
		expect(usage.note).toBe('Grok reports no usage limit for this account');
		expect(usage.error).toBeUndefined();
	});

	test('an allowance and what was spent of it become one limit that resets with the billing month', () => {
		const usage = mapBilling(
			{
				config: {
					monthlyLimit: { val: 200 },
					used: { val: 50 },
					billingPeriodEnd: '2026-12-01T00:00:00+00:00',
				},
			},
			'now',
		);
		expect(usage.windows).toEqual([
			{
				key: 'month',
				label: 'month',
				span: 'month',
				percent: 25,
				resetsAt: '2026-12-01T00:00:00+00:00',
			},
		]);
		expect(usage.note).toBeUndefined();
	});

	test('a share the service works out itself is used as it is', () => {
		const usage = mapBilling(
			{ config: { creditUsagePercent: 61.26, monthlyLimit: { val: 0 } } },
			'now',
		);
		expect(usage.windows.map((window) => window.percent)).toEqual([61.3]);
	});

	test('more spent than allowed reads as full, not past it', () => {
		const usage = mapBilling({ config: { monthlyLimit: { val: 10 }, used: { val: 25 } } }, 'now');
		expect(usage.windows[0]?.percent).toBe(100);
	});

	test('an answer with nothing in it is no limit, not a crash', () => {
		expect(mapBilling({}, 'now').windows).toEqual([]);
	});
});

describe('the login Grok keeps', () => {
	test('is the sign-in that holds a key, whatever it is filed under', () => {
		expect(loginIn({ 'https://auth.example::id': login('x') })).toEqual(login('x'));
		expect(loginIn({ stale: { email: 'old@example.com' }, live: login('x') })).toEqual(login('x'));
	});

	test('a file with no sign-in in it reads as none', () => {
		expect(loginIn({})).toBeNull();
		expect(loginIn(null)).toBeNull();
		expect(loginIn([login('x')])).toBeNull();
	});

	test('is read from the folder Grok is told to use', async () => {
		await withHome(async (home) => {
			process.env.GROK_HOME = home;
			expect(await new GrokProvider().readAgentCredential()).toBeNull();
			await Bun.write(join(home, 'auth.json'), JSON.stringify({ somewhere: login('x') }));
			expect(await new GrokProvider().readAgentCredential()).toEqual(login('x'));
		});
	});

	test('names its account from the login itself, with the plan when the service says', async () => {
		const calls = fakeFetch(() => json({ subscriptionTier: 'GrokPro' }));
		expect(await new GrokProvider().identify(login('2099-01-01T00:00:00Z'))).toEqual({
			email: 'someone@example.com',
			plan: 'GrokPro',
		});
		expect(calls[0]?.url).toBe('https://cli-chat-proxy.grok.com/v1/user?include=subscription');
	});

	test('still names its account when the service does not answer', async () => {
		fakeFetch(() => json({}, 503));
		expect(await new GrokProvider().identify(login('2099-01-01T00:00:00Z'))).toEqual({
			email: 'someone@example.com',
		});
	});
});

describe('asking the service', () => {
	test('reads the billing record with the login as it is', async () => {
		const calls = fakeFetch(() => json(NOTHING_REPORTED));
		await new GrokProvider().fetchUsage(login('2099-01-01T00:00:00Z'));
		expect(calls.map((call) => call.url)).toEqual(['https://cli-chat-proxy.grok.com/v1/billing']);
		expect(calls[0]?.headers.authorization).toBe('Bearer access-1');
	});

	test('a refusal is reported with its status', async () => {
		fakeFetch(() => json({}, 401));
		await expect(
			new GrokProvider().fetchUsage(login('2099-01-01T00:00:00Z')),
		).rejects.toMatchObject({ status: 401 });
	});
});

describe('renewing the login', () => {
	test('gives a new key and a new token for renewing, since the service stops honouring the old one', async () => {
		const calls = fakeFetch(() =>
			json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 21600 }),
		);
		const provider = new GrokProvider();
		const saved = login('2020-01-01T00:00:00Z');
		const renewed = await provider.refreshIfNeeded(saved);
		expect(calls[0]?.url).toBe('https://auth.x.ai/oauth2/token');
		const form = new URLSearchParams(calls[0]?.body);
		expect(form.get('grant_type')).toBe('refresh_token');
		expect(form.get('refresh_token')).toBe('refresh-1');
		expect(form.get('client_id')).toBe('client-1');
		expect(renewed.key).toBe('access-2');
		expect(renewed.refresh_token).toBe('refresh-2');
		expect(renewed.email).toBe('someone@example.com');
		expect(provider.expiresAt(renewed)).toBeGreaterThan(Date.now() + 5 * 3_600_000);
		expect(provider.sharesToken(saved, renewed)).toBe(false);
		expect(saved.key).toBe('access-1');
	});

	test('a login still good is not renewed', async () => {
		const calls = fakeFetch(() => json({}));
		const saved = login('2099-01-01T00:00:00Z');
		expect(await new GrokProvider().refreshIfNeeded(saved)).toBe(saved);
		expect(calls).toEqual([]);
	});

	test('a sign-in the service has ended reads as a login that no longer works', async () => {
		fakeFetch(() => json({ error: 'invalid_grant' }, 400));
		await expect(new GrokProvider().refreshIfNeeded(login('2020-01-01T00:00:00Z'))).rejects.toThrow(
			'invalid_grant',
		);
	});

	test('says when its login runs out, so it is renewed before then', () => {
		const provider = new GrokProvider();
		expect(provider.expiresAt(login('2099-01-01T00:00:00Z'))).toBe(
			Date.parse('2099-01-01T00:00:00Z'),
		);
		expect(provider.expiresAt({ key: 'a' })).toBeUndefined();
	});
});

describe('putting a login in use', () => {
	test('files it where Grok looks, in place of the one that was there', async () => {
		await withHome(async (home) => {
			process.env.GROK_HOME = home;
			const provider = new GrokProvider();
			await provider.writeAgentCredential(login('2099-01-01T00:00:00Z'));
			const other = {
				...login('2099-02-01T00:00:00Z'),
				key: 'access-9',
				email: 'other@example.com',
			};
			await provider.writeAgentCredential(other);
			expect(await provider.readAgentCredential()).toEqual(other);
			const file = (await Bun.file(join(home, 'auth.json')).json()) as Record<string, unknown>;
			expect(Object.keys(file)).toEqual(['https://auth.x.ai::client-1']);
		});
	});

	test('is written so only you can read it', async () => {
		await withHome(async (home) => {
			process.env.GROK_HOME = home;
			await new GrokProvider().writeAgentCredential(login('2099-01-01T00:00:00Z'));
			const { mode } = await Bun.file(join(home, 'auth.json')).stat();
			expect(mode & 0o777).toBe(0o600);
		});
	});

	test('a folder of its own holds a login of its own, for running as that account', async () => {
		await withHome(async (home) => {
			const provider = new GrokProvider();
			expect(await provider.session.readLogin(home)).toBeNull();
			await provider.session.writeLogin(home, login('2099-01-01T00:00:00Z'));
			expect(await provider.session.readLogin(home)).toEqual(login('2099-01-01T00:00:00Z'));
			expect(provider.session.homeVariable).toBe('GROK_HOME');
		});
	});
});
