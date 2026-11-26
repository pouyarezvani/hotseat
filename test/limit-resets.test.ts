import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from '../src/core/auto.ts';
import {
	collectState,
	currentResets,
	failedReading,
	freshUsage,
	loadCache,
	readAgainSoon,
	recordAfterReset,
} from '../src/core/collect.ts';
import { ResetNotSent, ResetRefused, ServiceError } from '../src/core/errors.ts';
import { acquireLock, writeJsonAtomic } from '../src/core/fs.ts';
import { useLimitReset } from '../src/core/limit-resets.ts';
import { readEvents } from '../src/core/log.ts';
import { snapshotPath, usageCachePath } from '../src/core/paths.ts';
import { removeAccount, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { loadSent, SETTLE_MS, saveSent, sentKey } from '../src/core/reset-journal.ts';
import type {
	Credential,
	LimitReset,
	State,
	UsageSnapshot,
	UsageWindow,
} from '../src/core/types.ts';
import { storeCredential } from '../src/core/vault.ts';
import { ClaudeProvider, cliVersion, mapResets, mapUsage } from '../src/providers/claude/index.ts';
import {
	CodexProvider,
	mapResetCredits,
	RESET_LIST_MAX_AGE_MS,
} from '../src/providers/codex/index.ts';
import { renderBoard } from '../src/ui/board.ts';
import { stripAnsi, type Theme } from '../src/ui/style.ts';
import { cred, fakeProviders, tokenOf } from './fake-provider.ts';
import { credential, withHome } from './helpers.ts';

/** The reset part of a real answer, for an account at 97% of its week and 47% of Fable. */
const PROGRAM = {
	eligible: true,
	ineligible_reason: null,
	grants: [
		{
			id: 'full-reset-2611',
			label: 'One full limit reset (November 2026)',
			resets_total: 1,
			resets_left: 1,
			ends_at: '2026-12-10T22:00:00+00:00',
			clears: ['seven_day', 'seven_day_overage_included'],
			paused: false,
			usable_now: true,
			percent_used: { seven_day: 97, seven_day_overage_included: 47 },
			type: 'weekly',
			unavailable_reason: null,
			gives_back_weekly: false,
		},
		{
			id: 'launch-2610-fable',
			label: 'New model launch: one Fable reset',
			resets_total: 1,
			resets_left: 1,
			ends_at: '2027-03-09T07:59:00+00:00',
			clears: ['seven_day_overage_included'],
			paused: false,
			usable_now: true,
			percent_used: { seven_day_overage_included: 47, seven_day: 97 },
			type: 'full',
			unavailable_reason: null,
			gives_back_weekly: true,
		},
	],
};

type Grant = (typeof PROGRAM.grants)[number];
const [WEEKLY_GRANT, FABLE_GRANT] = PROGRAM.grants as [Grant, Grant];

const USAGE = {
	five_hour: { utilization: 3, resets_at: '2026-11-23T08:00:00+00:00' },
	seven_day: { utilization: 97, resets_at: '2026-11-24T04:59:59.831646+00:00' },
	limits: [
		{
			kind: 'weekly_scoped',
			percent: 47,
			resets_at: '2026-11-24T04:59:59.831810+00:00',
			scope: { model: { display_name: 'Fable' } },
		},
	],
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Asked {
	url: string;
	headers: Record<string, string>;
}

/** Answers each request by its address, and remembers what was asked. */
function serve(answers: Record<string, () => Response>): Asked[] {
	const asked: Asked[] = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
			const path = Object.keys(answers).find((key) => url.startsWith(key));
			if (!path) throw new Error(`unexpected request to ${url}`);
			return (answers[path] as () => Response)();
		},
		{ preconnect: () => undefined },
	) as unknown as typeof fetch;
	return asked;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('Claude resets', () => {
	test('are named after what they clear, in the names the board uses', () => {
		const snapshot = mapUsage({ ...USAGE, cedar_ember: PROGRAM }, '2026-11-23T05:00:00.000Z');
		expect(snapshot.limitResets).toEqual([
			{
				id: 'full-reset-2611',
				title: 'Weekly reset',
				clears: ['week', 'Fable'],
				windowKeys: ['seven_day', 'weekly_scoped:Fable'],
				expiresAt: '2026-12-10T22:00:00.000Z',
				detail: 'One full limit reset (November 2026)',
			},
			{
				id: 'launch-2610-fable',
				title: 'Fable reset',
				clears: ['Fable'],
				windowKeys: ['weekly_scoped:Fable'],
				givesBack: 'week',
				expiresAt: '2027-03-09T07:59:00.000Z',
				detail: 'New model launch: one Fable reset',
			},
		]);
		expect(snapshot.limitResetsReadAt).toBe('2026-11-23T05:00:00.000Z');
	});

	test('say nothing when the service declined because of how it was asked', () => {
		for (const reason of ['surface', 'cli_version']) {
			expect(
				mapResets({ eligible: false, ineligible_reason: reason, grants: [] }, []),
			).toBeUndefined();
		}
		expect(mapUsage(USAGE, '2026-11-23T05:00:00.000Z').limitResets).toBeUndefined();
	});

	test('are none when the account itself has none', () => {
		expect(mapResets({ eligible: false, ineligible_reason: 'plan', grants: [] }, [])).toEqual([]);
		expect(
			mapResets({ eligible: true, grants: [{ ...WEEKLY_GRANT, resets_left: 0 }] }, []),
		).toEqual([]);
	});

	test('say why one cannot be used right now, and how many uses one has left', () => {
		const [cooling, paused, twice] =
			mapResets(
				{
					eligible: true,
					grants: [
						{ ...WEEKLY_GRANT, id: 'a', usable_now: false, unavailable_reason: 'cooldown' },
						{ ...WEEKLY_GRANT, id: 'b', paused: true },
						{ ...WEEKLY_GRANT, id: 'c', resets_left: 2 },
					],
				},
				[],
			) ?? [];
		expect(cooling?.blocked).toBe('cooling down after the last one');
		expect(paused?.blocked).toBe('paused');
		expect(twice?.left).toBe(2);
		expect(twice?.blocked).toBeUndefined();
	});

	test('one with nothing to clear cannot be used, as Claude itself says', () => {
		const windows: UsageWindow[] = [
			{ key: 'seven_day', label: 'week', percent: 1 },
			{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 0 },
		];
		const limitResets =
			mapResets({ eligible: true, grants: [WEEKLY_GRANT, FABLE_GRANT] }, windows) ?? [];
		const [weekly, fable] = currentResets(
			{ fetchedAt: '', windows, limitResets },
			Date.parse('2026-11-22T12:00:00Z'),
		);
		expect(weekly?.blocked).toBeUndefined();
		expect(fable?.blocked).toBe('no Fable usage to reset right now');
	});

	test('one whose limits have all started over since cannot be used, and a block the service gave stays', () => {
		const now = Date.parse('2026-11-22T12:00:00Z');
		const passed = new Date(now - 60_000).toISOString();
		const windows: UsageWindow[] = [
			{ key: 'seven_day', label: 'week', percent: 80, resetsAt: passed },
			{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 30, resetsAt: passed },
		];
		const resets: LimitReset[] = [
			{ id: 'w', title: 'Weekly reset', clears: ['week', 'Fable'] },
			{ id: 'p', title: 'Weekly reset', clears: ['week'], blocked: 'paused' },
		];
		const [weekly, paused] = currentResets({ fetchedAt: '', windows, limitResets: resets }, now);
		expect(weekly?.blocked).toBe('no week or Fable usage to reset right now');
		expect(paused?.blocked).toBe('paused');
	});

	test('one that may clear any of several model limits has nothing to clear when they are all empty', () => {
		const windows: UsageWindow[] = [
			{ key: 'seven_day', label: 'week', percent: 3 },
			{ key: 'weekly_scoped:Opus', label: 'Opus', percent: 0 },
			{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 0 },
		];
		const limitResets =
			mapResets(
				{ eligible: true, grants: [{ ...FABLE_GRANT, label: 'One reset', percent_used: null }] },
				windows,
			) ?? [];
		expect(limitResets[0]?.windowKeys).toEqual(['weekly_scoped:Opus', 'weekly_scoped:Fable']);
		const [reset] = currentResets(
			{ fetchedAt: '', windows, limitResets },
			Date.parse('2026-11-22T12:00:00Z'),
		);
		expect(reset?.blocked).toBe('no model limit usage to reset right now');
	});

	test('none can be used while the account cannot be read and no limits are known', () => {
		const [reset] = currentResets(
			{
				fetchedAt: '',
				windows: [],
				error: 'could not reach the service',
				limitResets: [{ id: 'w', title: 'Weekly reset', clears: ['week'] }],
			},
			Date.parse('2026-11-22T12:00:00Z'),
		);
		expect(reset?.blocked).toBe('its usage could not be read just now');
	});

	test('match the model limit by the number the service reports for it', () => {
		const windows: UsageWindow[] = [
			{ key: 'weekly_scoped:Opus', label: 'Opus', percent: 12 },
			{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 47 },
		];
		const [reset] = mapResets({ eligible: true, grants: [FABLE_GRANT] }, windows) ?? [];
		expect(reset?.clears).toEqual(['Fable']);
		const [blind] =
			mapResets(
				{
					eligible: true,
					grants: [{ ...FABLE_GRANT, label: 'One reset', percent_used: null }],
				},
				windows,
			) ?? [];
		expect(blind?.clears).toEqual(['model limit']);
		expect(blind?.title).toBe('model limit reset');
	});

	test('name the model their own description names, even when two models read the same', () => {
		const windows: UsageWindow[] = [
			{ key: 'weekly_scoped:Opus', label: 'Opus', percent: 40 },
			{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 40 },
		];
		const grant = { ...FABLE_GRANT, percent_used: { seven_day_overage_included: 40 } };
		const [reset] = mapResets({ eligible: true, grants: [grant] }, windows) ?? [];
		expect(reset?.clears).toEqual(['Fable']);
		expect(reset?.title).toBe('Fable reset');
		const [unnamed] =
			mapResets({ eligible: true, grants: [{ ...grant, label: 'A reset' }] }, windows) ?? [];
		expect(unnamed?.clears).toEqual(['model limit']);
	});

	test('come with the usage read itself, asked for as Claude Code', async () => {
		const asked = serve({
			'https://api.anthropic.com/api/oauth/usage': () => json({ ...USAGE, cedar_ember: PROGRAM }),
		});
		const snapshot = await new ClaudeProvider().fetchUsage(credential('token'));
		expect(asked).toHaveLength(1);
		expect(asked[0]?.url).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1');
		expect(asked[0]?.headers['user-agent']).toMatch(
			/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/,
		);
		expect(snapshot.windows.map((window) => window.label)).toEqual(['5h', 'week', 'Fable']);
		expect(snapshot.limitResets?.map((reset) => reset.title)).toEqual([
			'Weekly reset',
			'Fable reset',
		]);
	});
});

describe('the Claude Code version named', () => {
	let home = '';
	afterEach(async () => {
		if (home) await rm(home, { recursive: true, force: true });
	});

	test('is the one the installed command points at, else the newest kept, else a known one', async () => {
		home = await mkdtemp(join(tmpdir(), 'hotseat-cli-'));
		expect(await cliVersion(home)).toMatch(/^\d+\.\d+\.\d+$/);
		const versions = join(home, '.local', 'share', 'claude', 'versions');
		await mkdir(versions, { recursive: true });
		for (const version of ['2.1.99', '2.1.100', 'notes'])
			await Bun.write(join(versions, version), '');
		expect(await cliVersion(home)).toBe('2.1.100');
		await mkdir(join(home, '.local', 'bin'), { recursive: true });
		await symlink(join(versions, '2.1.99'), join(home, '.local', 'bin', 'claude'));
		expect(await cliVersion(home)).toBe('2.1.99');
	});
});

function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

const CODEX_LOGIN = {
	tokens: {
		access_token: jwt({ exp: Math.floor(Date.parse('2099-01-01T00:00:00Z') / 1000) }),
		refresh_token: 'refresh',
		account_id: 'acct',
	},
	last_refresh: new Date().toISOString(),
};

const CREDITS = {
	credits: [
		{
			id: 'credit-1',
			reset_type: 'codex_rate_limits',
			status: 'available',
			expires_at: '2026-12-01T22:47:59.873894Z',
			title: 'Full reset',
			description: "You've been granted one free rate limit reset.",
		},
		{
			id: 'credit-2',
			reset_type: 'codex_rate_limits',
			status: 'redeemed',
			expires_at: '2026-12-12T22:43:47.839011Z',
			title: 'Full reset',
		},
	],
	available_count: 1,
};

function codexUsage(count: number | undefined): unknown {
	return {
		email: 'c@example.com',
		rate_limit: {
			primary_window: { used_percent: 17, limit_window_seconds: 604_800, reset_at: 1_795_800_580 },
			secondary_window: null,
		},
		...(count !== undefined
			? { rate_limit_reset_credits: { available_count: count, applicable_available_count: 0 } }
			: {}),
	};
}

describe('Codex reset credits', () => {
	test('list only the ones still waiting to be used, clearing every Codex limit', () => {
		const windows: UsageWindow[] = [{ key: 'primary', label: 'week', percent: 17 }];
		expect(mapResetCredits(CREDITS, windows)).toEqual([
			{
				id: 'credit-1',
				title: 'Full reset',
				clears: ['week'],
				windowKeys: ['primary'],
				clearsEvery: true,
				expiresAt: '2026-12-01T22:47:59.873Z',
				detail: "You've been granted one free rate limit reset.",
			},
		]);
	});

	test('a list that is missing or disagrees with the count is not taken as the list', async () => {
		for (const [count, answer] of [
			[1, {}],
			[2, CREDITS],
		] as const) {
			serve({
				'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(count)),
				'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json(answer),
			});
			expect((await new CodexProvider().fetchUsage(CODEX_LOGIN)).limitResets).toBeUndefined();
		}
	});

	test('a list the count has since contradicted is shown but read again before it is trusted', async () => {
		const readAt = new Date(Date.now() - 60_000).toISOString();
		const previous: UsageSnapshot = {
			fetchedAt: readAt,
			windows: [],
			limitResets: [{ id: 'credit-a', title: 'Full reset', clears: [], clearsEvery: true }],
			limitResetsReadAt: readAt,
		};
		serve({
			'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(2)),
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json({}, 500),
		});
		const contradicted = await new CodexProvider().fetchUsage(CODEX_LOGIN, previous);
		expect(contradicted.limitResets?.map((reset) => reset.id)).toEqual(['credit-a']);
		expect(contradicted.limitResetsStale).toBe(true);
		const asked = serve({
			'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(1)),
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json(CREDITS),
		});
		const again = await new CodexProvider().fetchUsage(CODEX_LOGIN, contradicted);
		expect(asked.map((entry) => entry.url)).toContain(
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
		);
		expect(again.limitResets?.map((reset) => reset.id)).toEqual(['credit-1']);
		expect(again.limitResetsStale).toBeUndefined();
	});

	test('a full reset is idle again once the undrawn limit in use has reset', () => {
		const at = Date.parse('2026-11-22T12:00:00Z');
		const snapshot: UsageSnapshot = {
			fetchedAt: '',
			windows: [{ key: 'primary', label: 'week', percent: 0 }],
			otherLimitsInUse: true,
			otherLimitsInUseUntil: new Date(at + 60 * 60_000).toISOString(),
			limitResets: [
				{
					id: 'c',
					title: 'Full reset',
					clears: ['week'],
					windowKeys: ['primary'],
					clearsEvery: true,
				},
			],
		};
		expect(currentResets(snapshot, at)[0]?.blocked).toBeUndefined();
		expect(currentResets(snapshot, at + 2 * 60 * 60_000)[0]?.blocked).toBe(
			'no week usage to reset right now',
		);
	});

	test('a credit with a blank id is not listed', () => {
		const windows: UsageWindow[] = [{ key: 'primary', label: 'week', percent: 17 }];
		const [first] = CREDITS.credits;
		if (!first) throw new Error('no credit in the fixture');
		const credits = { credits: [{ ...first, id: '' }, first] };
		expect(mapResetCredits(credits, windows)?.map((reset) => reset.id)).toEqual(['credit-1']);
	});

	test('a full reset is not taken as idle while a limit Codex does not draw is in use', async () => {
		serve({
			'https://chatgpt.com/backend-api/wham/usage': () =>
				json({
					...(codexUsage(1) as Record<string, unknown>),
					rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604_800 } },
					additional_rate_limits: [
						{ limit_name: 'other', rate_limit: { primary_window: { used_percent: 100 } } },
					],
				}),
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json(CREDITS),
		});
		const snapshot = await new CodexProvider().fetchUsage(CODEX_LOGIN);
		expect(snapshot.otherLimitsInUse).toBe(true);
		const [reset] = currentResets(snapshot, Date.parse('2026-11-22T12:00:00Z'));
		expect(reset?.blocked).toBeUndefined();
		const { otherLimitsInUse: _busy, ...withoutOthers } = snapshot;
		const quiet = currentResets(withoutOthers, Date.parse('2026-11-22T12:00:00Z'));
		expect(quiet[0]?.blocked).toBe('no week usage to reset right now');
	});

	test('are asked for when the usage answer says there are some', async () => {
		const asked = serve({
			'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(1)),
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json(CREDITS),
		});
		const snapshot = await new CodexProvider().fetchUsage(CODEX_LOGIN);
		expect(asked.map((entry) => entry.url)).toEqual([
			'https://chatgpt.com/backend-api/wham/usage',
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
		]);
		expect(asked[1]?.headers['chatgpt-account-id']).toBe('acct');
		expect(snapshot.limitResets?.map((reset) => reset.id)).toEqual(['credit-1']);
		expect(Date.parse(snapshot.limitResetsReadAt ?? '')).toBeGreaterThanOrEqual(
			Date.parse(snapshot.fetchedAt),
		);
	});

	test('a list is dated by when its own request began, not by the usage read before it', async () => {
		serve({
			'https://chatgpt.com/backend-api/wham/usage': () => {
				Bun.sleepSync(30);
				return json(codexUsage(1));
			},
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json(CREDITS),
		});
		const snapshot = await new CodexProvider().fetchUsage(CODEX_LOGIN);
		expect(
			Date.parse(snapshot.limitResetsReadAt ?? '') - Date.parse(snapshot.fetchedAt),
		).toBeGreaterThanOrEqual(25);
	});

	test('are not asked for when there are none, or the count has not moved since a recent list', async () => {
		const asked = serve({
			'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(0)),
		});
		const none = await new CodexProvider().fetchUsage(CODEX_LOGIN);
		expect(none.limitResets).toEqual([]);
		expect(asked).toHaveLength(1);

		serve({ 'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(1)) });
		const readAt = new Date(Date.now() - 60 * 60_000).toISOString();
		const previous: UsageSnapshot = {
			fetchedAt: readAt,
			windows: [],
			limitResets: [{ id: 'credit-1', title: 'Full reset', clears: [], clearsEvery: true }],
			limitResetsReadAt: readAt,
		};
		const kept = await new CodexProvider().fetchUsage(CODEX_LOGIN, previous);
		expect(kept.limitResets).toEqual([
			{
				id: 'credit-1',
				title: 'Full reset',
				clears: ['week'],
				windowKeys: ['primary'],
				clearsEvery: true,
			},
		]);
		expect(kept.limitResetsReadAt).toBe(readAt);
	});

	test('are asked for again once the list is old, the count moves, or one has run out', async () => {
		const asked = serve({
			'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(1)),
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json(CREDITS),
		});
		const old = new Date(Date.now() - RESET_LIST_MAX_AGE_MS - 60_000).toISOString();
		const recent = new Date(Date.now() - 60_000).toISOString();
		const one = { id: 'credit-1', title: 'Full reset', clears: ['week'] };
		const previous = [
			{ fetchedAt: old, windows: [], limitResets: [one], limitResetsReadAt: old },
			{
				fetchedAt: recent,
				windows: [],
				limitResets: [one, { ...one, id: 'x' }],
				limitResetsReadAt: recent,
			},
			{
				fetchedAt: recent,
				windows: [],
				limitResets: [{ ...one, expiresAt: new Date(Date.now() - 1000).toISOString() }],
				limitResetsReadAt: recent,
			},
		];
		for (const last of previous) await new CodexProvider().fetchUsage(CODEX_LOGIN, last);
		expect(asked.filter((entry) => entry.url.includes('reset-credits'))).toHaveLength(3);
	});

	test('a list that cannot be read leaves the usage reading whole, and the last list standing', async () => {
		serve({
			'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(1)),
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits': () => json({}, 500),
		});
		const snapshot = await new CodexProvider().fetchUsage(CODEX_LOGIN);
		expect(snapshot.windows).toHaveLength(1);
		expect(snapshot.limitResets).toBeUndefined();
	});

	test('a usage answer that says nothing of credits says nothing of them', async () => {
		const asked = serve({
			'https://chatgpt.com/backend-api/wham/usage': () => json(codexUsage(undefined)),
		});
		expect((await new CodexProvider().fetchUsage(CODEX_LOGIN)).limitResets).toBeUndefined();
		expect(asked).toHaveLength(1);
	});
});

describe('resets on the board', () => {
	const T = Date.parse('2026-11-22T12:00:00Z');
	const reset = (id: string, expiresAt: string) => ({
		id,
		title: 'Weekly reset',
		clears: ['week'],
		expiresAt,
	});

	async function oneAccount() {
		const providers = fakeProviders();
		const a = await updateRegistry((registry) =>
			upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
		);
		await updateRegistry((registry) => {
			registry.active.claude = a.id;
		});
		await storeCredential(a, cred('A'));
		providers.claude.identities.set('A', { email: 'a@example.com' });
		providers.claude.installed = cred('A');
		return { providers, a };
	}

	test('are kept from the last list while a read says nothing of them, and dropped once run out', async () => {
		await withHome(async () => {
			const { providers } = await oneAccount();
			const windows: UsageWindow[] = [{ key: 'seven_day', label: 'week', percent: 40 }];
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows,
				limitResets: [
					reset('soon', new Date(T + 60 * 60_000).toISOString()),
					reset('later', '2027-03-09T07:59:00.000Z'),
				],
				limitResetsReadAt: new Date(T).toISOString(),
			}));
			await collectState({ providers, now: T });
			providers.claude.readings.set('A', () => ({ fetchedAt: new Date(T).toISOString(), windows }));
			const later = T + 2 * 60 * 60_000;
			const state = await collectState({ providers, now: later });
			const usage = state.providers.claude.accounts[0]?.usage;
			expect(usage?.limitResets?.map((entry) => entry.id)).toEqual(['later']);
			expect(providers.claude.previousGiven.at(-1)?.limitResets).toHaveLength(2);
		});
	});

	test('that read the same are one line counting all their uses', async () => {
		await withHome(async () => {
			const { providers } = await oneAccount();
			const fable = {
				title: 'Fable reset',
				clears: ['Fable'],
				givesBack: 'week',
				expiresAt: '2027-03-09T07:59:00.000Z',
			};
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 40 }],
				limitResets: [
					{ ...fable, id: 'launch', detail: 'New model launch' },
					reset('weekly', '2026-12-10T22:00:00.000Z'),
					{ ...fable, id: 'tenure', detail: 'Six months of tenure', left: 2 },
				],
			}));
			const state = await collectState({ providers, now: T });
			expect(state.providers.claude.accounts[0]?.usage?.limitResets).toEqual([
				{
					...fable,
					id: 'launch',
					left: 3,
					detail: 'New model launch; Six months of tenure',
					ids: ['launch', 'tenure'],
				},
				reset('weekly', '2026-12-10T22:00:00.000Z'),
			]);
		});
	});

	test('are kept through a failed read after the limits they clear have reset', async () => {
		await withHome(async () => {
			const { providers } = await oneAccount();
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'seven_day',
						label: 'week',
						percent: 40,
						resetsAt: new Date(T + 60 * 60_000).toISOString(),
					},
				],
				limitResets: [reset('later', '2027-03-09T07:59:00.000Z')],
			}));
			await collectState({ providers, now: T });
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			const state = await collectState({ providers, now: T + 2 * 60 * 60_000 });
			const usage = state.providers.claude.accounts[0]?.usage;
			expect(usage?.error).toBeDefined();
			expect(usage?.limitResets?.map((entry) => entry.id)).toEqual(['later']);
		});
	});

	test('a reading that says nothing new still brings word of a limit the board does not draw', async () => {
		await withHome(async () => {
			const { providers } = await oneAccount();
			const full: LimitReset = {
				id: 'c',
				title: 'Full reset',
				clears: ['week'],
				windowKeys: ['primary'],
				clearsEvery: true,
			};
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'primary',
						label: 'week',
						percent: 0,
						resetsAt: new Date(T + 24 * 60 * 60_000).toISOString(),
					},
				],
				limitResets: [full],
			}));
			const first = await collectState({ providers, now: T });
			expect(first.providers.claude.accounts[0]?.usage?.limitResets?.[0]?.blocked).toBeDefined();
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'primary', label: 'week', percent: 0 }],
				limitResets: [full],
				otherLimitsInUse: true,
			}));
			const later = await collectState({ providers, now: T + 10 * 60_000 });
			const usage = later.providers.claude.accounts[0]?.usage;
			expect(usage?.otherLimitsInUse).toBe(true);
			expect(usage?.limitResets?.[0]?.blocked).toBeUndefined();
		});
	});

	test('a fresh list read on a reading that says nothing new replaces the old list whole', async () => {
		await withHome(async () => {
			const { providers } = await oneAccount();
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'primary',
						label: 'week',
						percent: 10,
						resetsAt: new Date(T + 24 * 60 * 60_000).toISOString(),
					},
				],
				limitResets: [reset('old', '2027-03-09T07:59:00.000Z')],
				limitResetsStale: true,
			}));
			await collectState({ providers, now: T });
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'primary', label: 'week', percent: 0 }],
				limitResets: [reset('new', '2027-03-09T07:59:00.000Z')],
				limitResetsReadAt: new Date(T + 10 * 60_000).toISOString(),
			}));
			await collectState({ providers, now: T + 10 * 60_000 });
			const entry = Object.values((await loadCache()).entries)[0];
			expect(entry?.snapshot.limitResets?.map((item) => item.id)).toEqual(['new']);
			expect(entry?.snapshot.limitResetsStale).toBeUndefined();
		});
	});

	test('are kept when the agent’s own reading replaces the numbers', async () => {
		await withHome(async () => {
			const { providers } = await oneAccount();
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 40 }],
				limitResets: [reset('later', '2027-03-09T07:59:00.000Z')],
			}));
			await collectState({ providers, now: T });
			providers.claude.local = {
				fetchedAtMs: T + 30_000,
				windows: [{ key: 'seven_day', label: 'week', percent: 45 }],
			};
			const state = await collectState({ providers, now: T + 60_000 });
			const usage = state.providers.claude.accounts[0]?.usage;
			expect(usage?.windows[0]?.percent).toBe(45);
			expect(usage?.limitResets?.map((entry) => entry.id)).toEqual(['later']);
		});
	});

	const savedZone = process.env.TZ;
	afterEach(() => {
		if (savedZone === undefined) delete process.env.TZ;
		else process.env.TZ = savedZone;
	});

	test('are listed under the limits, with what each clears and when it runs out', () => {
		process.env.TZ = 'UTC';
		const theme: Theme = { color: false, truecolor: false, unicode: true, width: 80 };
		const state: State = {
			version: 1,
			updatedAt: new Date(T).toISOString(),
			providers: {
				claude: {
					activeAccountId: 'a1',
					accounts: [
						{
							id: 'a1',
							provider: 'claude',
							email: 'a@example.com',
							slot: 1,
							disabled: false,
							addedAt: '2026-09-01T00:00:00Z',
							usage: {
								fetchedAt: new Date(T).toISOString(),
								windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
								limitResets: [
									{
										id: 'w',
										title: 'Weekly reset',
										clears: ['week', 'Fable'],
										expiresAt: '2026-12-10T22:00:00.000Z',
									},
									{
										id: 'f',
										title: 'Fable reset',
										clears: ['Fable'],
										givesBack: 'week',
										expiresAt: '2027-03-09T07:59:00.000Z',
									},
									{
										id: 's',
										title: 'Full reset',
										clears: ['week'],
										expiresAt: new Date(T + 26 * 3_600_000).toISOString(),
									},
									{
										id: 'gone',
										title: 'Old reset',
										clears: ['week'],
										expiresAt: new Date(T - 1000).toISOString(),
									},
									{
										id: 'l',
										title: 'Last call',
										clears: ['week'],
										expiresAt: new Date(T + 5 * 3_600_000).toISOString(),
									},
								],
							},
						},
					],
				},
				codex: { accounts: [] },
				grok: { accounts: [] },
				antigravity: { accounts: [] },
			},
		};
		const text = stripAnsi(renderBoard(state, { theme, barWidth: 10, now: T }));
		expect(text).toContain('├ Weekly reset  week + Fable  expires Dec 10 (18 days)');
		expect(text).toContain('├ Fable reset  Fable + its share of week  expires Mar 9 (107 days)');
		expect(text).toContain('├ Full reset  week  expires Nov 23 (1 day)');
		expect(text).toContain('╰ Last call  week  expires today (5h 0m)');
		expect(text).not.toContain('Old reset');
	});

	test('are listed even when every limit is hidden', () => {
		process.env.TZ = 'UTC';
		const theme: Theme = { color: false, truecolor: false, unicode: true, width: 80 };
		const state: State = {
			version: 1,
			updatedAt: new Date(T).toISOString(),
			providers: {
				claude: {
					accounts: [
						{
							id: 'a1',
							provider: 'claude',
							email: 'a@example.com',
							slot: 1,
							disabled: false,
							addedAt: '2026-09-01T00:00:00Z',
							usage: {
								fetchedAt: new Date(T).toISOString(),
								windows: [{ key: 'seven_day', label: 'week', percent: 40, hidden: true }],
								limitResets: [reset('w', '2026-12-10T12:00:00.000Z')],
							},
						},
					],
				},
				codex: { accounts: [] },
				grok: { accounts: [] },
				antigravity: { accounts: [] },
			},
		};
		const text = stripAnsi(renderBoard(state, { theme, barWidth: 10, now: T }));
		expect(text).toContain('├ every limit hidden');
		expect(text).toContain('╰ Weekly reset  week  expires Dec 10 (18 days)');
	});
});

const PROFILE = {
	account: { email_address: 'a@example.com', uuid: 'acct-uuid' },
	organization: { uuid: 'org-uuid', name: 'Org' },
};

describe('using a Claude reset', () => {
	test('names the reset to the organization, with the request id it is given, as Claude Code', async () => {
		const sent: { url: string; body: unknown; headers: Record<string, string> }[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url = String(input);
				if (url.endsWith('/api/oauth/profile')) return json(PROFILE);
				sent.push({
					url,
					body: JSON.parse(String(init?.body)),
					headers: (init?.headers ?? {}) as Record<string, string>,
				});
				return json({ result: 'reset', resets_left: 0, cleared: ['seven_day'] });
			},
			{ preconnect: () => undefined },
		) as unknown as typeof fetch;
		const outcome = await new ClaudeProvider().useReset(
			credential('token'),
			'full-reset-2611',
			'request-1',
		);
		expect(outcome).toEqual({ used: true });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(
			'https://api.anthropic.com/api/organizations/org-uuid/reset_rate_limits',
		);
		const body = sent[0]?.body as Record<string, unknown>;
		expect(body.program).toBe('cedar_ember');
		expect(body.grant_id).toBe('full-reset-2611');
		expect(body.request_id).toBe('request-1');
		expect(sent[0]?.headers['user-agent']).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
	});

	test('sends nothing when, asked last, the reset is no longer wanted', async () => {
		const sent: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url.endsWith('/api/oauth/profile')) return json(PROFILE);
				sent.push(url);
				return json({ result: 'reset' });
			},
			{ preconnect: () => undefined },
		) as unknown as typeof fetch;
		let asked = false;
		const outcome = await new ClaudeProvider()
			.useReset(credential('token'), 'full-reset-2611', 'request-1', () => {
				asked = true;
				return false;
			})
			.catch((error: unknown) => error);
		expect(asked).toBe(true);
		expect(outcome).toBeInstanceOf(ResetNotSent);
		expect(sent).toEqual([]);
	});

	test('says why, in words, when the service does not use it', async () => {
		serve({
			'https://api.anthropic.com/api/oauth/profile': () => json(PROFILE),
			'https://api.anthropic.com/api/organizations/': () =>
				json({ result: 'unavailable', reason: 'not_next_grant' }),
		});
		expect(
			await new ClaudeProvider().useReset(credential('token'), 'launch-2610-fable', 'request-1'),
		).toEqual({
			used: false,
			refused: 'another reset has to be used first',
		});
	});

	test('an answer it does not recognise is not taken as a refusal', async () => {
		for (const answer of [{}, { result: 'something_new' }, null]) {
			serve({
				'https://api.anthropic.com/api/oauth/profile': () => json(PROFILE),
				'https://api.anthropic.com/api/organizations/': () => json(answer),
			});
			const failure = await new ClaudeProvider()
				.useReset(credential('token'), 'full-reset-2611', 'request-1')
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(ResetRefused);
			expect(failure).not.toBeInstanceOf(ResetNotSent);
		}
	});

	test('an eligible answer without its list of grants is no list', () => {
		expect(mapResets({ eligible: true }, [])).toBeUndefined();
	});

	test('a model the reading shows is not named when the grant’s own number says otherwise', () => {
		const windows: UsageWindow[] = [{ key: 'weekly_scoped:Opus', label: 'Opus', percent: 10 }];
		const [reset] = mapResets({ eligible: true, grants: [FABLE_GRANT] }, windows) ?? [];
		expect(reset?.clears).toEqual(['model limit']);
		const [idle] = currentResets(
			{
				fetchedAt: '',
				windows: [{ key: 'weekly_scoped:Opus', label: 'Opus', percent: 0 }],
				limitResets: reset ? [reset] : [],
			},
			Date.parse('2026-11-22T12:00:00Z'),
		);
		expect(idle?.blocked).toBeUndefined();
	});

	test('a list with a grant it cannot tell apart is shown, but marked as not the whole list', () => {
		const snapshot = mapUsage(
			{
				...USAGE,
				cedar_ember: { eligible: true, grants: [{ ...WEEKLY_GRANT, id: '' }, FABLE_GRANT] },
			},
			'2026-11-22T12:00:00.000Z',
		);
		expect(snapshot.limitResets?.map((reset) => reset.id)).toEqual(['launch-2610-fable']);
		expect(snapshot.limitResetsIncomplete).toBe(true);
		expect(mapUsage({ ...USAGE, cedar_ember: PROGRAM }, 'x').limitResetsIncomplete).toBeUndefined();
	});

	test('a model limit it cannot name still has nothing to clear when every model it could be is empty', () => {
		const windows: UsageWindow[] = [
			{ key: 'weekly_scoped:Opus', label: 'Opus', percent: 0 },
			{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 0 },
		];
		const grant = {
			...FABLE_GRANT,
			label: 'One reset',
			percent_used: { seven_day_overage_included: 0 },
		};
		const limitResets = mapResets({ eligible: true, grants: [grant] }, windows) ?? [];
		expect(limitResets[0]?.clears).toEqual(['model limit']);
		const [reset] = currentResets(
			{ fetchedAt: '', windows, limitResets },
			Date.parse('2026-11-22T12:00:00Z'),
		);
		expect(reset?.blocked).toBe('no model limit usage to reset right now');
	});

	test('one that also clears a limit the board does not draw is never called empty', () => {
		const windows: UsageWindow[] = [
			{ key: 'seven_day', label: 'week', percent: 0 },
			{ key: 'weekly_scoped:Opus', label: 'Opus', percent: 10 },
		];
		const grant = {
			...WEEKLY_GRANT,
			percent_used: { seven_day: 0, seven_day_overage_included: 47 },
		};
		const limitResets = mapResets({ eligible: true, grants: [grant] }, windows) ?? [];
		expect(limitResets[0]?.clearsUnseen).toBe(true);
		const [reset] = currentResets(
			{ fetchedAt: '', windows, limitResets },
			Date.parse('2026-11-22T12:00:00Z'),
		);
		expect(reset?.blocked).toBeUndefined();
	});

	test('one that clears only a limit the board does not draw, reported empty, has nothing to clear', () => {
		const windows: UsageWindow[] = [{ key: 'seven_day', label: 'week', percent: 40 }];
		const grant = {
			...WEEKLY_GRANT,
			id: 'cowork',
			clears: ['seven_day_cowork'],
			percent_used: { seven_day_cowork: 0 },
		};
		const limitResets = mapResets({ eligible: true, grants: [grant] }, windows) ?? [];
		const [reset] = currentResets(
			{ fetchedAt: '', windows, limitResets },
			Date.parse('2026-11-22T12:00:00Z'),
		);
		expect(reset?.blocked).toBe('no Cowork usage to reset right now');
	});

	test('a grant with a blank id is not listed', () => {
		expect(
			mapResets({ eligible: true, grants: [{ ...WEEKLY_GRANT, id: '  ' }, FABLE_GRANT] }, [])?.map(
				(reset) => reset.id,
			),
		).toEqual(['launch-2610-fable']);
	});

	test('refuses an id no Claude reset could have, without asking', async () => {
		const asked = serve({});
		const failure = await new ClaudeProvider()
			.useReset(credential('token'), '../../x', 'request-1')
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(asked).toHaveLength(0);
	});
});

describe('using a Codex reset', () => {
	test('consumes the credit named, with the request id it is given', async () => {
		const sent: { url: string; method?: string; body: unknown }[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				sent.push({
					url: String(input),
					...(init?.method ? { method: init.method } : {}),
					body: JSON.parse(String(init?.body)),
				});
				return new Response(null, { status: 204 });
			},
			{ preconnect: () => undefined },
		) as unknown as typeof fetch;
		expect(await new CodexProvider().useReset(CODEX_LOGIN, 'credit-1', 'request-1')).toEqual({
			used: true,
		});
		expect(sent[0]?.url).toBe(
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
		);
		expect(sent[0]?.method).toBe('POST');
		const body = sent[0]?.body as Record<string, unknown>;
		expect(body.credit_id).toBe('credit-1');
		expect(body.redeem_request_id).toBe('request-1');
	});

	test('consumes nothing when, asked last, the credit is no longer wanted', async () => {
		const sent: string[] = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				sent.push(String(input));
				return new Response(null, { status: 204 });
			},
			{ preconnect: () => undefined },
		) as unknown as typeof fetch;
		const outcome = await new CodexProvider()
			.useReset(CODEX_LOGIN, 'credit-1', 'request-1', () => false)
			.catch((error: unknown) => error);
		expect(outcome).toBeInstanceOf(ResetNotSent);
		expect(sent).toEqual([]);
	});

	test('a page that is not JSON, or a redirect, is not taken as an answer either way', async () => {
		for (const response of [
			() =>
				new Response('<html>sign in</html>', {
					status: 200,
					headers: { 'content-type': 'text/html' },
				}),
			() => new Response(null, { status: 302, headers: { location: 'https://example.com/login' } }),
		]) {
			serve({ 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume': response });
			const failure = await new CodexProvider()
				.useReset(CODEX_LOGIN, 'credit-1', 'request-1')
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			const status = failure instanceof ResetRefused ? failure.status : undefined;
			expect(status === undefined || status < 400).toBe(true);
		}
	});

	test('an answer cut off after it began is not taken as carried out', async () => {
		serve({
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume': () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"ok":'));
							controller.error(new Error('connection reset'));
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		});
		const failure = await new CodexProvider()
			.useReset(CODEX_LOGIN, 'credit-1', 'request-1')
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(ResetRefused);
	});

	test('a refused request is an error, not a used reset', async () => {
		serve({
			'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume': () =>
				json({ detail: 'nope' }, 409),
		});
		const failure = await new CodexProvider()
			.useReset(CODEX_LOGIN, 'credit-1', 'request-1')
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
	});
});

describe('use-reset', () => {
	const T = Date.parse('2026-11-22T12:00:00Z');
	const MIN = 60_000;

	const weekly: LimitReset = {
		id: 'weekly',
		title: 'Weekly reset',
		clears: ['week'],
		expiresAt: '2026-12-10T22:00:00.000Z',
	};
	const other: LimitReset = { ...weekly, id: 'other' };
	const blocked: LimitReset = { ...weekly, id: 'blocked', blocked: 'paused' };

	/** Account A in use, holding these resets, read at whatever time the clock says. */
	async function holding(resets: LimitReset[], clock = { now: T }) {
		const providers = fakeProviders();
		const a = await updateRegistry((registry) =>
			upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
		);
		await updateRegistry((registry) => {
			registry.active.claude = a.id;
		});
		await storeCredential(a, cred('A'));
		providers.claude.identities.set('A', { email: 'a@example.com', confirmed: true });
		providers.claude.installed = cred('A');
		const read = () => ({
			fetchedAt: new Date(clock.now).toISOString(),
			windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
			limitResets: resets,
			limitResetsReadAt: new Date(clock.now).toISOString(),
		});
		providers.claude.readings.set('A', read);
		const used: string[] = [];
		const requests: string[] = [];
		const answer = async (credential: Credential, id: string, requestId: string) => {
			used.push(`${String(credential.token)}:${id}`);
			requests.push(requestId);
			return { used: true };
		};
		const lose = async (_credential: Credential, _id: string, requestId: string) => {
			requests.push(requestId);
			throw new Error('fetch failed');
		};
		providers.claude.useReset = answer;
		await collectState({ providers, now: clock.now });
		return { providers, a, used, requests, answer, lose, read, clock };
	}

	const attempt = (promise: Promise<unknown>) => promise.then(() => 'ok').catch(String);

	test('uses the reset named, with the login in use, and reads the account again', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([blocked, weekly]);
			const reads = providers.claude.calls.fetchUsage;
			const { reset, outcome } = await useLimitReset('claude', a, 'weekly', providers, () => T);
			expect(outcome.used).toBe(true);
			expect(reset.title).toBe('Weekly reset');
			expect(used).toEqual(['A:weekly']);
			expect(providers.claude.calls.fetchUsage).toBeGreaterThan(reads);
			const logged = await readEvents(1);
			expect(logged.find((event) => event.kind === 'reset-used')?.id).toBe('weekly');
		});
	});

	test('with none named, uses the first that can be used now', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([blocked, weekly]);
			await useLimitReset('claude', a, undefined, providers, () => T);
			expect(used).toEqual(['A:weekly']);
		});
	});

	test('spends nothing on a reset the account was not seen to hold, or one run out', async () => {
		await withHome(async () => {
			const lapsed = { ...weekly, id: 'lapsed', expiresAt: new Date(T - 1000).toISOString() };
			const { providers, a, used } = await holding([lapsed]);
			for (const id of ['typo', 'lapsed']) {
				expect(await attempt(useLimitReset('claude', a, id, providers, () => T))).toContain(
					'holds no reset',
				);
			}
			expect(used).toEqual([]);
		});
	});

	test('spends nothing on a blocked reset, even named, or on an empty id', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([blocked, weekly]);
			for (const id of ['blocked', '', '  ']) {
				expect(await attempt(useLimitReset('claude', a, id, providers, () => T))).not.toBe('ok');
			}
			expect(used).toEqual([]);
		});
	});

	test('never acts with a login that turns out to be another account', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await updateRegistry((registry) => {
				registry.active.claude = b.id;
			});
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.identities.set('C', { email: 'b@example.com', confirmed: true });
			for (const token of ['B', 'C']) {
				providers.claude.readings.set(token, () => ({
					fetchedAt: new Date(T).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
					limitResets: [weekly],
				}));
			}
			providers.claude.installed = cred('B');
			await storeCredential(b, cred('B'));
			await storeCredential(a, cred('C'));
			expect(await attempt(useLimitReset('claude', a, 'weekly', providers, () => T))).toContain(
				'signed in as b@example.com',
			);
			expect(used).toEqual([]);
		});
	});

	test('never acts with a login the service has not itself confirmed', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([weekly]);
			providers.claude.identities.set('A', { email: 'a@example.com' });
			expect(await attempt(useLimitReset('claude', a, 'weekly', providers, () => T))).toContain(
				'could not confirm',
			);
			expect(used).toEqual([]);
		});
	});

	test('a use whose answer was lost is asked for again as the same request, and holds back any other', async () => {
		await withHome(async () => {
			const { providers, a, used, requests, answer, lose, read } = await holding([weekly, other]);
			let failReads = false;
			providers.claude.readings.set('A', () => {
				if (failReads) throw new Error('fetch failed');
				return read();
			});
			providers.claude.useReset = async (credential, id, requestId) => {
				failReads = true;
				return lose(credential, id, requestId);
			};
			const lost = await attempt(useLimitReset('claude', a, 'weekly', providers, () => T));
			expect(lost).toContain('may have been used');
			failReads = false;
			providers.claude.useReset = answer;
			const later = () => T + MIN;
			expect(await attempt(useLimitReset('claude', a, 'other', providers, later))).toContain(
				'got no answer',
			);
			expect(await attempt(useLimitReset('claude', a, 'weekly', providers, later))).toBe('ok');
			expect(requests).toHaveLength(2);
			expect(requests[1]).toBe(requests[0]);
			expect(used).toEqual(['A:weekly']);
			expect(await attempt(useLimitReset('claude', a, 'weekly', providers, later))).toContain(
				'was just used',
			);
		});
	});

	test('a lost answer is settled only by a good reading of the resets, taken minutes after it', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const { providers, a, used, answer, lose, read } = await holding([weekly, other], clock);
			providers.claude.useReset = lose;
			await attempt(useLimitReset('claude', a, 'weekly', providers, () => clock.now));
			providers.claude.useReset = answer;

			clock.now = T + SETTLE_MS + 10 * MIN;
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			expect(
				await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now)),
			).toContain('could not read');
			expect((await loadSent())[sentKey('claude', a)]?.map((use) => use.resetId)).toEqual([
				'weekly',
			]);

			providers.claude.readings.set('A', read);
			expect(await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now))).toBe(
				'ok',
			);
			expect(used).toEqual(['A:other']);
		});
	});

	test('a reading kept from elsewhere never settles a lost answer, only one made with the confirmed login', async () => {
		await withHome(async () => {
			const { providers, a, used, answer, lose } = await holding([weekly, other]);
			providers.claude.useReset = lose;
			await attempt(useLimitReset('claude', a, 'weekly', providers, () => T));
			providers.claude.useReset = answer;
			const muchLater = T + 60 * MIN;
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no reading of A');
			cache.entries[a.id] = {
				...entry,
				fetchedAtMs: muchLater,
				attemptedAtMs: muchLater,
				snapshot: { ...entry.snapshot, limitResetsReadAt: new Date(muchLater).toISOString() },
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			expect(
				await attempt(useLimitReset('claude', a, 'other', providers, () => T + MIN)),
			).toContain('got no answer');
			expect(used).toEqual([]);
		});
	});

	test('a refusal to a second try leaves the first still unsettled', async () => {
		await withHome(async () => {
			const { providers, a, used, answer, lose } = await holding([weekly, other]);
			providers.claude.useReset = lose;
			await attempt(useLimitReset('claude', a, 'weekly', providers, () => T));
			for (const failure of [
				new ResetRefused('reset request failed with 409', 409),
				new ResetNotSent('could not ask which organization this login is in'),
			]) {
				providers.claude.useReset = async () => {
					throw failure;
				};
				await attempt(useLimitReset('claude', a, 'weekly', providers, () => T + MIN));
			}
			providers.claude.useReset = answer;
			expect(
				await attempt(useLimitReset('claude', a, 'other', providers, () => T + MIN)),
			).toContain('got no answer');
			expect(used).toEqual([]);
		});
	});

	test('a first try the service refused outright, or that was never sent, used nothing', async () => {
		await withHome(async () => {
			const { providers, a, used, answer } = await holding([weekly, other]);
			for (const failure of [
				new ResetRefused('reset request failed with 409', 409),
				new ResetNotSent('could not ask which organization this login is in'),
			]) {
				providers.claude.useReset = async () => {
					throw failure;
				};
				await attempt(useLimitReset('claude', a, 'weekly', providers, () => T));
			}
			providers.claude.useReset = answer;
			expect(await attempt(useLimitReset('claude', a, 'other', providers, () => T))).toBe('ok');
			expect(used).toEqual(['A:other']);
		});
	});

	test('fresh numbers that show nothing to clear stop a use, even when the list could not be read', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
			}));
			expect(await attempt(useLimitReset('claude', a, 'weekly', providers, () => T))).toContain(
				'no week usage to reset right now',
			);
			expect(used).toEqual([]);
		});
	});

	test('a lost answer still holds back other uses after the account is removed and added again', async () => {
		await withHome(async () => {
			const { providers, a, used, answer, lose } = await holding([weekly, other]);
			providers.claude.useReset = lose;
			await attempt(useLimitReset('claude', a, 'weekly', providers, () => T));
			providers.claude.useReset = answer;
			await updateRegistry((registry) => removeAccount(registry, a.id));
			const again = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'A@example.com' }),
			);
			expect(again.id).not.toBe(a.id);
			await updateRegistry((registry) => {
				registry.active.claude = again.id;
			});
			await storeCredential(again, cred('A'));
			expect(
				await attempt(useLimitReset('claude', again, 'other', providers, () => T + MIN)),
			).toContain('got no answer');
			expect(used).toEqual([]);
		});
	});

	test('the wait for a lost answer counts from when the attempt ended, not when it began', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const { providers, a, used, answer } = await holding([weekly, other], clock);
			providers.claude.useReset = async () => {
				clock.now += 19_000;
				throw new Error('fetch failed');
			};
			await attempt(useLimitReset('claude', a, 'weekly', providers, () => clock.now));
			providers.claude.useReset = answer;
			const ended = T + 19_000;
			clock.now = ended + SETTLE_MS - 5_000;
			expect(
				await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now)),
			).toContain('got no answer');
			clock.now = ended + SETTLE_MS + 5_000;
			expect(await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now))).toBe(
				'ok',
			);
			expect(used).toEqual(['A:other']);
		});
	});

	test('a reset just used is passed over for another like it, by default or among the ids named', async () => {
		await withHome(async () => {
			const twin = { ...weekly, id: 'twin' };
			const third = { ...weekly, id: 'third' };
			const { providers, a, used } = await holding([weekly, twin, third]);
			await useLimitReset('claude', a, undefined, providers, () => T);
			await useLimitReset('claude', a, undefined, providers, () => T);
			await useLimitReset('claude', a, ['weekly', 'twin', 'third'], providers, () => T);
			expect(used).toEqual(['A:weekly', 'A:twin', 'A:third']);
			expect(
				await attempt(useLimitReset('claude', a, ['weekly', 'twin'], providers, () => T)),
			).toContain('was just used');
		});
	});

	test('a use cut off before its answer is waited on from when it is found', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const { providers, a, used } = await holding([weekly, other], clock);
			const { saveSent } = await import('../src/core/reset-journal.ts');
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + 60_000, inFlight: true },
			]);
			const found = T + 10 * MIN;
			clock.now = found;
			expect(
				await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now)),
			).toContain('got no answer');
			clock.now = found + SETTLE_MS - 1000;
			expect(
				await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now)),
			).toContain('got no answer');
			clock.now = found + SETTLE_MS + 1000;
			expect(await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now))).toBe(
				'ok',
			);
			expect(used).toEqual(['A:other']);
		});
	});

	test('no reset is used without a good reading made just now with its own login', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([weekly]);
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			expect(await attempt(useLimitReset('claude', a, 'weekly', providers, () => T))).toContain(
				'could not read',
			);
			expect(used).toEqual([]);
		});
	});

	test('of several named, the first that can be used, in the order named', async () => {
		await withHome(async () => {
			const full = { ...weekly, id: 'full' };
			const session = { ...weekly, id: 'session' };
			const { providers, a, used } = await holding([full, session]);
			await useLimitReset('claude', a, ['session', 'full'], providers, () => T);
			expect(used).toEqual(['A:session']);
		});
	});

	test('a second try the service declines says the first may still have counted', async () => {
		await withHome(async () => {
			const { providers, a, lose } = await holding([weekly]);
			providers.claude.useReset = lose;
			await attempt(useLimitReset('claude', a, 'weekly', providers, () => T));
			providers.claude.useReset = async () => ({ used: false, refused: 'cooling down' });
			const { outcome, retried } = await useLimitReset(
				'claude',
				a,
				'weekly',
				providers,
				() => T + MIN,
			);
			expect(outcome.used).toBe(false);
			expect(retried).toBe(true);
		});
	});

	test('the board holds back other resets while one got no answer, and the one just used', async () => {
		await withHome(async () => {
			const twin = { ...weekly, id: 'twin', title: 'Twin reset' };
			const { providers, a } = await holding([weekly, other, twin]);
			const { saveSent } = await import('../src/core/reset-journal.ts');
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', title: 'Weekly reset', requestId: 'r-1', at: T },
				{ resetId: 'twin', title: 'Twin reset', requestId: 'r-2', at: T, used: true },
			]);
			const state = await collectState({ providers, now: T + MIN });
			const shown = state.providers.claude.accounts[0]?.usage?.limitResets ?? [];
			const byId = new Map(
				shown.flatMap((reset) => (reset.ids ?? [reset.id]).map((id) => [id, reset])),
			);
			expect(byId.get('weekly')?.blocked).toBeUndefined();
			expect(byId.get('other')?.blocked).toContain('waiting to hear whether the Weekly reset');
			expect(byId.get('twin')?.blocked).toBe('it was just used');
			const later = await collectState({ providers, now: T + 20 * MIN });
			const after = later.providers.claude.accounts[0]?.usage?.limitResets ?? [];
			expect(after.every((reset) => reset.blocked === undefined)).toBe(true);
		});
	});

	test('a reading that brings no limits is no reading to act on', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [],
			}));
			expect(await attempt(useLimitReset('claude', a, 'weekly', providers, () => T))).toContain(
				'could not read',
			);
			expect(used).toEqual([]);
		});
	});

	test('a list that is not the whole list never settles a lost answer', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const { providers, a, used, answer, lose } = await holding([weekly, other], clock);
			providers.claude.useReset = lose;
			await attempt(useLimitReset('claude', a, 'weekly', providers, () => clock.now));
			providers.claude.useReset = answer;
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(clock.now).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
				limitResets: [other],
				limitResetsReadAt: new Date(clock.now).toISOString(),
				limitResetsIncomplete: true,
			}));
			clock.now = T + SETTLE_MS + 10 * MIN;
			expect(
				await attempt(useLimitReset('claude', a, 'other', providers, () => clock.now)),
			).toContain('got no answer');
			expect(used).toEqual([]);
		});
	});

	test('after a use, the reading made right after it is what is shown', async () => {
		await withHome(async () => {
			const { providers, a, answer } = await holding([weekly]);
			providers.claude.useReset = async (credential, id, requestId) => {
				const outcome = await answer(credential, id, requestId);
				providers.claude.readings.set('A', () => ({
					fetchedAt: new Date(T).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				}));
				return outcome;
			};
			await useLimitReset('claude', a, 'weekly', providers, () => T + MIN);
			const state = await collectState({ providers, now: T + 5 * MIN, force: true });
			expect(state.providers.claude.accounts[0]?.usage?.windows[0]?.percent).toBe(0);
		});
	});

	test('after a use with no reading to follow, the numbers from before are set aside, not shown', async () => {
		await withHome(async () => {
			const { providers, a, answer } = await holding([weekly]);
			providers.claude.useReset = async (credential, id, requestId) => {
				const outcome = await answer(credential, id, requestId);
				providers.claude.readings.set('A', () => {
					throw new Error('fetch failed');
				});
				return outcome;
			};
			await useLimitReset('claude', a, 'weekly', providers, () => T + MIN);
			providers.claude.local = {
				fetchedAtMs: T + 30_000,
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
			};
			const state = await collectState({ providers, now: T + 2 * MIN });
			const usage = state.providers.claude.accounts[0]?.usage;
			expect(usage?.windows).toEqual([]);
			expect(usage?.error).toBeDefined();
		});
	});

	test('a pass that read before a reset was used neither keeps nor shows its numbers', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.fetchDelayMs = 50;
			const before = collectState({ providers, now: T + 5 * MIN, force: true });
			await Bun.sleep(10);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + 6 * MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				},
				T + 6 * MIN,
			);
			const state = await before;
			expect(state.providers.claude.accounts[0]?.usage?.windows[0]?.percent).toBe(0);
			expect((await loadCache()).entries[a.id]?.snapshot.windows[0]?.percent).toBe(0);
		});
	});

	test('after a use, the status line shows the account as it is now, as it is asked to', async () => {
		await withHome(async () => {
			const { providers, a, answer } = await holding([weekly]);
			const state = await collectState({ providers, now: T });
			await writeJsonAtomic(snapshotPath(), state);
			providers.claude.useReset = async (credential, id, requestId) => {
				const outcome = await answer(credential, id, requestId);
				providers.claude.readings.set('A', () => ({
					fetchedAt: new Date(T).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				}));
				return outcome;
			};
			await useLimitReset('claude', a, 'weekly', providers, () => T + MIN);
			const line = await Bun.file(snapshotPath()).json();
			const shown = line.providers.claude.accounts[0].usage;
			const fresh = await freshUsage(a, 'claude', shown, T + 2 * MIN);
			expect(fresh?.windows[0]?.percent).toBe(0);
		});
	});

	test('of several named, one the service turns down outright gives way to the next', async () => {
		await withHome(async () => {
			const { providers, a, used, answer } = await holding([weekly, other]);
			providers.claude.useReset = async (credential, id, requestId) =>
				id === 'weekly'
					? { used: false, refused: 'it was already used' }
					: answer(credential, id, requestId);
			const { reset, outcome } = await useLimitReset(
				'claude',
				a,
				['weekly', 'other'],
				providers,
				() => T,
			);
			expect(outcome.used).toBe(true);
			expect(reset.id).toBe('other');
			expect(used).toEqual(['A:other']);
		});
	});

	test('an automatic switch waiting on a use in progress sees it and holds', async () => {
		await withHome(async () => {
			const { providers, a, used, answer } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			let open: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			providers.claude.useReset = async (credential, id, requestId) => {
				await gate;
				return answer(credential, id, requestId);
			};
			const using = useLimitReset('claude', a, 'weekly', providers, () => T + MIN);
			await Bun.sleep(50);
			const ticking = tick({ providers, now: T + MIN, awake: async () => true });
			await Bun.sleep(50);
			open();
			await using;
			const reports = await ticking;
			expect(used).toEqual(['A:weekly']);
			expect(reports.some((report) => report.outcome === 'switched')).toBe(false);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('a use asked for while a switch is landing waits for it, never landing in between', async () => {
		await withHome(async () => {
			const { providers, a, used } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			let using: Promise<unknown> | undefined;
			let usedBeforeSwitch: string[] = [];
			await tick({
				providers,
				now: T + MIN,
				awake: async () => true,
				beforeSwitch: async () => {
					using = useLimitReset('claude', a, 'weekly', providers, () => T + MIN).catch(String);
					await Bun.sleep(100);
					usedBeforeSwitch = [...used];
				},
			});
			await using;
			expect(usedBeforeSwitch).toEqual([]);
		});
	});

	test('a use on record sets aside the numbers read before it, even when nothing after it ran', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + MIN, used: true },
			]);
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			const state = await collectState({ providers, now: T + 5 * MIN });
			expect(state.providers.claude.accounts[0]?.usage?.windows).toEqual([]);
			expect((await loadCache()).entries[a.id]?.resetAtMs).toBe(T + MIN);
		});
	});

	test('a pass that loaded the cache before a reset returns what is stored, not what it loaded', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + MIN });
			await Bun.sleep(20);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				},
				T + MIN + 1,
			);
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((entry) => entry.id === a.id);
			expect(shownA?.usage?.windows[0]?.percent).toBe(0);
		});
	});

	test('the agent’s own reading after a reset does not bring back limits from before it', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{ key: 'seven_day', label: 'week', percent: 97 },
					{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 97 },
				],
			}));
			await collectState({ providers, now: T + 61_000, force: true });
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + 2 * MIN, used: true },
			]);
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			providers.claude.local = {
				fetchedAtMs: T + 3 * MIN,
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			};
			const state = await collectState({ providers, now: T + 3.5 * MIN });
			const labels = state.providers.claude.accounts[0]?.usage?.windows.map(
				(window) => window.label,
			);
			expect(labels).toEqual(['week']);
		});
	});

	test('a reading after a reset keeps the time of the reset with it', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			await recordAfterReset(a.id, undefined, T + MIN);
			await collectState({ providers, now: T + 10 * MIN, force: true });
			const entry = (await loadCache()).entries[a.id];
			expect(entry?.fetchedAtMs).toBe(T + 10 * MIN);
			expect(entry?.resetAtMs).toBeGreaterThanOrEqual(T + MIN);
		});
	});

	test('a use still marked as being sent sets aside the numbers read before it', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + MIN, inFlight: true },
			]);
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			const state = await collectState({ providers, now: T + 5 * MIN });
			expect(state.providers.claude.accounts[0]?.usage?.windows).toEqual([]);
		});
	});

	test('the status line sets aside numbers from before a use on record, though nothing after it ran', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const state = await collectState({ providers, now: T });
			const shown = state.providers.claude.accounts[0]?.usage;
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + MIN, used: true },
			]);
			const fresh = await freshUsage(a, 'claude', shown, T + 2 * MIN);
			expect(fresh?.windows).toEqual([]);
		});
	});

	test('a pass that read before a use was made still shows that reset as just used', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 10 * MIN });
			await Bun.sleep(20);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + 10 * MIN, used: true },
			]);
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((entry) => entry.id === a.id);
			expect(shownA?.usage?.limitResets?.[0]?.blocked).toBe('it was just used');
		});
	});

	test('limits carried into a reading made after a reset come from after the reset', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{ key: 'seven_day', label: 'week', percent: 97 },
					{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 97 },
				],
			}));
			await collectState({ providers, now: T + 61_000, force: true });
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.local = {
				fetchedAtMs: T + 3 * MIN,
				windows: [{ key: 'seven_day', label: 'week', percent: 5 }],
			};
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 3.5 * MIN });
			await Bun.sleep(20);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + 2 * MIN).toISOString(),
					windows: [
						{ key: 'seven_day', label: 'week', percent: 0 },
						{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 0 },
					],
				},
				T + 2 * MIN,
			);
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((entry) => entry.id === a.id);
			const byLabel = Object.fromEntries(
				(shownA?.usage?.windows ?? []).map((window) => [window.label, window.percent]),
			);
			expect(byLabel).toEqual({ week: 5, Fable: 0 });
		});
	});

	test('a record of uses that cannot be read stops every use', async () => {
		await withHome(async (home) => {
			const { providers, a, used } = await holding([weekly]);
			for (const content of ['{ not json', '{"x": "not a list"}', '[]', 'null']) {
				await Bun.write(join(home, 'reset-pending.json'), content);
				expect(await attempt(useLimitReset('claude', a, 'weekly', providers, () => T))).toContain(
					'record of reset uses',
				);
			}
			expect(used).toEqual([]);
		});
	});

	test('a use made while a pass ran holds back what that pass read before it, and is kept with the account', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 10 * MIN, force: true });
			await Bun.sleep(20);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + 10 * MIN + 1, used: true },
			]);
			const state = await pass;
			expect(state.providers.claude.accounts[0]?.usage?.windows).toEqual([]);
			expect((await loadCache()).entries[a.id]?.resetAtMs).toBe(T + 10 * MIN + 1);
		});
	});

	test('a reading stored after a reset is shown over a pass’s own, even with limits it carried', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{ key: 'seven_day', label: 'week', percent: 97 },
					{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 97 },
				],
			}));
			await collectState({ providers, now: T + 61_000, force: true });
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.local = {
				fetchedAtMs: T + 3 * MIN,
				windows: [{ key: 'seven_day', label: 'week', percent: 5 }],
			};
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 3.5 * MIN });
			await Bun.sleep(20);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + 3.2 * MIN).toISOString(),
					windows: [
						{ key: 'seven_day', label: 'week', percent: 0 },
						{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 0 },
					],
				},
				T + 3.2 * MIN,
			);
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((entry) => entry.id === a.id);
			const byLabel = Object.fromEntries(
				(shownA?.usage?.windows ?? []).map((window) => [window.label, window.percent]),
			);
			expect(byLabel).toEqual({ week: 0, Fable: 0 });
		});
	});

	test('a use still being sent holds numbers back only while it is, and is not kept once gone', async () => {
		await withHome(async (home) => {
			const { providers, a } = await holding([weekly]);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + MIN, inFlight: true },
			]);
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			const sender = await acquireLock(home, 1_000, 'reset.lock');
			const held = await collectState({ providers, now: T + 30_000 });
			expect(held.providers.claude.accounts[0]?.usage?.windows).toEqual([]);
			expect((await loadCache()).entries[a.id]?.resetAtMs).toBeUndefined();
			await saveSent(sentKey('claude', a), []);
			await sender.release();
			const after = await collectState({ providers, now: T + 40_000 });
			expect(after.providers.claude.accounts[0]?.usage?.windows[0]?.percent).toBe(97);
		});
	});

	test('the status line sets aside numbers from before a use even for an account not yet read', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + MIN, used: true },
			]);
			const shown = {
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
			};
			const fresh = await freshUsage(
				{ id: 'not-in-cache', email: a.email },
				'claude',
				shown,
				T + 2 * MIN,
			);
			expect(fresh?.windows).toEqual([]);
			const before = await freshUsage(
				{ id: 'not-in-cache', email: 'b@example.com' },
				'claude',
				shown,
				T + 2 * MIN,
			);
			expect(before).toEqual(shown);
		});
	});

	test('the board holds other resets for as long as a use is being sent, and a used one only until it can settle', async () => {
		await withHome(async (home) => {
			const { providers, a } = await holding([weekly, other]);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', title: 'Weekly reset', requestId: 'r-1', at: T, inFlight: true },
			]);
			const sender = await acquireLock(home, 1_000, 'reset.lock');
			const sending = await collectState({ providers, now: T + 5 * MIN });
			await sender.release();
			const whileSent = sending.providers.claude.accounts[0]?.usage?.limitResets ?? [];
			const otherWhileSent = whileSent.find((reset) => (reset.ids ?? [reset.id]).includes('other'));
			expect(otherWhileSent?.blocked).toContain('waiting to hear whether the Weekly reset');
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', title: 'Weekly reset', requestId: 'r-1', at: T + 5 * MIN, used: true },
			]);
			const settled = await collectState({ providers, now: T + 5 * MIN + SETTLE_MS + 1 });
			const after = settled.providers.claude.accounts[0]?.usage?.limitResets ?? [];
			expect(after.every((reset) => reset.blocked === undefined)).toBe(true);
		});
	});

	test('a reset that runs out while another is being turned down is not sent', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const soon = { ...other, id: 'soon', expiresAt: new Date(T + 30_000).toISOString() };
			const { providers, a, used } = await holding([weekly, soon], clock);
			providers.claude.useReset = async (_credential, id) => {
				used.push(id);
				clock.now = T + MIN;
				return { used: false, refused: 'it was already used' };
			};
			const { reset, outcome } = await useLimitReset(
				'claude',
				a,
				['weekly', 'soon'],
				providers,
				() => clock.now,
			);
			expect(outcome.used).toBe(false);
			expect(reset.id).toBe('weekly');
			expect(used).toEqual(['weekly']);
		});
	});

	test('a lost answer whose reset runs out while the use waits its turn is not sent, nor passed over', async () => {
		await withHome(async () => {
			const clock = { now: T + MIN };
			const soon = { ...weekly, id: 'soon', expiresAt: new Date(T + 90_000).toISOString() };
			const { providers, a, used } = await holding([soon, other], clock);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'soon', title: 'Weekly reset', requestId: 'r-1', at: T },
			]);
			const { holdSwitch } = await import('../src/core/switch-lock.ts');
			const switching = await holdSwitch('claude');
			const pending = attempt(useLimitReset('claude', a, undefined, providers, () => clock.now));
			await Bun.sleep(100);
			clock.now = T + 2 * MIN;
			await switching.release();
			expect(await pending).toContain('got no answer');
			expect(used).toEqual([]);
		});
	});

	test('a later read that fails keeps a newer reading another pass stored, and adds its failure', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => {
				throw new Error('fetch failed');
			});
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 10 * MIN, force: true });
			await Bun.sleep(20);
			const cache = await loadCache();
			cache.entries[a.id] = {
				snapshot: {
					fetchedAt: new Date(T + 9 * MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 36 }],
				},
				fetchedAtMs: T + 9 * MIN,
				attemptedAtMs: T + 9 * MIN,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((entry) => entry.id === a.id)?.usage;
			expect(shownA?.windows[0]?.percent).toBe(36);
			expect(shownA?.error).toBeDefined();
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(36);
			expect(stored?.attemptedAtMs).toBe(T + 10 * MIN);
		});
	});

	test('the reading made after a use does not replace a newer one stored meanwhile', async () => {
		await withHome(async () => {
			const clock = { now: T + MIN };
			const { providers, a, answer } = await holding([weekly], clock);
			let writing: Promise<void> | undefined;
			providers.claude.useReset = async (credential, id, requestId) => {
				const outcome = await answer(credential, id, requestId);
				providers.claude.readings.set('A', () => ({
					fetchedAt: new Date(T + MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				}));
				providers.claude.fetchDelayMs = 80;
				writing = (async () => {
					await Bun.sleep(30);
					const cache = await loadCache();
					const entry = cache.entries[a.id];
					if (!entry) return;
					cache.entries[a.id] = {
						...entry,
						snapshot: {
							fetchedAt: new Date(T + MIN + 5).toISOString(),
							windows: [{ key: 'seven_day', label: 'week', percent: 25 }],
						},
						fetchedAtMs: T + MIN + 5,
						attemptedAtMs: T + MIN + 5,
					};
					await writeJsonAtomic(usageCachePath(), cache, 0o600);
					clock.now = T + MIN + 10;
				})();
				return outcome;
			};
			await useLimitReset('claude', a, 'weekly', providers, () => clock.now);
			await writing;
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(25);
			expect(stored?.resetAtMs).toBe(T + MIN);
		});
	});

	test('a use left in flight by a sender that stopped is waited on from when it is found, then lets others go', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly, other]);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', title: 'Weekly reset', requestId: 'r-1', at: T, inFlight: true },
			]);
			const found = await collectState({ providers, now: T + 20 * MIN });
			const atFirst = found.providers.claude.accounts[0]?.usage?.limitResets ?? [];
			expect(
				atFirst.find((reset) => (reset.ids ?? [reset.id]).includes('other'))?.blocked,
			).toContain('waiting to hear');
			expect((await loadSent())[sentKey('claude', a)]).toEqual([
				{ resetId: 'weekly', title: 'Weekly reset', requestId: 'r-1', at: T + 20 * MIN },
			]);
			const later = await collectState({ providers, now: T + 20 * MIN + SETTLE_MS + 1 });
			const after = later.providers.claude.accounts[0]?.usage?.limitResets ?? [];
			expect(after.every((reset) => reset.blocked === undefined)).toBe(true);
		});
	});

	test('a use still being sent is left in flight while its sender holds the lock', async () => {
		await withHome(async (home) => {
			const { providers, a } = await holding([weekly, other]);
			const use = { resetId: 'weekly', requestId: 'r-1', at: T, inFlight: true as const };
			await saveSent(sentKey('claude', a), [use]);
			const sender = await acquireLock(home, 1_000, 'reset.lock');
			await collectState({ providers, now: T + 20 * MIN });
			await sender.release();
			expect((await loadSent())[sentKey('claude', a)]).toEqual([use]);
		});
	});

	/** A pass that runs while a use of A is in flight, kept going by a slow read of B. */
	async function passDuringSend(home: string) {
		const held = await holding([weekly]);
		const b = await updateRegistry((registry) =>
			upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
		);
		await storeCredential(b, cred('B'));
		held.providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
		held.providers.claude.readings.set('B', () => ({
			fetchedAt: new Date(T).toISOString(),
			windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
		}));
		await saveSent(sentKey('claude', held.a), [
			{ resetId: 'weekly', requestId: 'r-1', at: T + MIN, inFlight: true },
		]);
		const sender = await acquireLock(home, 1_000, 'reset.lock');
		held.providers.claude.fetchDelayMs = 150;
		const pass = collectState({ providers: held.providers, now: T + 30_000 });
		await Bun.sleep(50);
		return { ...held, sender, pass };
	}

	test('a pass begun while a use was being sent shows the numbers once the service turned it down', async () => {
		await withHome(async (home) => {
			const { a, sender, pass } = await passDuringSend(home);
			await saveSent(sentKey('claude', a), []);
			await sender.release();
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((entry) => entry.id === a.id);
			expect(shownA?.usage?.windows[0]?.percent).toBe(97);
		});
	});

	test('a pass begun while a use was being sent shows the reading made after it', async () => {
		await withHome(async (home) => {
			const { a, sender, pass } = await passDuringSend(home);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + 40_000, used: true },
			]);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + 40_000).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				},
				T + 40_000,
			);
			await sender.release();
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((entry) => entry.id === a.id);
			expect(shownA?.usage?.windows[0]?.percent).toBe(0);
		});
	});

	test('a use whose answer was lost sets aside the numbers from before it in the cache itself', async () => {
		await withHome(async () => {
			const { providers, a, lose } = await holding([weekly]);
			providers.claude.useReset = lose;
			expect(
				await attempt(useLimitReset('claude', a, 'weekly', providers, () => T + MIN)),
			).toContain('no answer');
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.resetAtMs).toBeGreaterThan(stored?.fetchedAtMs ?? Number.POSITIVE_INFINITY);
		});
	});

	/** Two accounts, A in use, read once at T, and a second set of fakes for a pass of their own. */
	async function twoPasses(firstRead: () => UsageSnapshot) {
		const held = await holding([weekly]);
		const b = await updateRegistry((registry) =>
			upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
		);
		await storeCredential(b, cred('B'));
		const fakes = () => {
			const providers = fakeProviders();
			providers.claude.identities.set('A', { email: 'a@example.com', confirmed: true });
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.installed = cred('A');
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			return providers;
		};
		held.providers.claude.readings.set('A', firstRead);
		held.providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
		await collectState({ providers: held.providers, now: T, force: true });
		const succeeding = fakes();
		succeeding.claude.readings.set('A', () => ({
			fetchedAt: new Date(T + 10 * MIN).toISOString(),
			windows: [{ key: 'seven_day', label: 'week', percent: 36 }],
		}));
		const failing = fakes();
		failing.claude.readings.set('A', () => {
			throw new Error('fetch failed');
		});
		return { ...held, succeeding, failing };
	}

	test('of two passes at once, a later one that fails first leaves the successful reading stored', async () => {
		await withHome(async () => {
			const { a, succeeding, failing } = await twoPasses(() => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
			}));
			succeeding.claude.fetchDelayMs = 80;
			const first = collectState({ providers: succeeding, now: T + 10 * MIN, force: true });
			await Bun.sleep(10);
			await collectState({ providers: failing, now: T + 11 * MIN, force: true });
			const state = await first;
			expect(
				state.providers.claude.accounts.find((x) => x.id === a.id)?.usage?.windows[0]?.percent,
			).toBe(36);
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(36);
			expect(stored?.snapshot.error).toBeDefined();
			expect(stored?.attemptedAtMs).toBe(T + 11 * MIN);
		});
	});

	test('of two passes at once, a later one that fails with run-out numbers does not erase a successful reading', async () => {
		await withHome(async () => {
			const { a, succeeding, failing } = await twoPasses(() => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'seven_day',
						label: 'week',
						percent: 97,
						resetsAt: new Date(T + 5 * MIN).toISOString(),
					},
				],
			}));
			failing.claude.fetchDelayMs = 80;
			const later = collectState({ providers: failing, now: T + 11 * MIN, force: true });
			await Bun.sleep(10);
			await collectState({ providers: succeeding, now: T + 10 * MIN, force: true });
			await later;
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(36);
		});
	});

	test('the status line shows numbers it had shown as awaiting a read once nothing holds them back', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const shown = {
				fetchedAt: new Date(T).toISOString(),
				windows: [],
				error: 'reading it again after a reset',
				errorKind: 'other' as const,
			};
			const fresh = await freshUsage(a, 'claude', shown, T + MIN);
			expect(fresh?.windows[0]?.percent).toBe(97);
		});
	});

	test('a stopped sender found early is waited on from when it was found, not from how long it might have run', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const { providers, a, used } = await holding([weekly, other], clock);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + 60_000, inFlight: true },
			]);
			await collectState({ providers, now: T + 5_000 });
			expect((await loadSent())[sentKey('claude', a)]).toEqual([
				{ resetId: 'weekly', requestId: 'r-1', at: T + 5_000 },
			]);
			clock.now = T + 5_000 + SETTLE_MS;
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(clock.now).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
				limitResets: [other],
				limitResetsReadAt: new Date(clock.now).toISOString(),
			}));
			await useLimitReset('claude', a, 'other', providers, () => clock.now);
			expect(used).toEqual(['A:other']);
		});
	});

	test('of two passes, the reading made later wins, whichever pass began first', async () => {
		await withHome(async () => {
			const { a, succeeding, failing } = await twoPasses(() => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
			}));
			const quick = failing;
			quick.claude.readings.set('A', () => ({
				fetchedAt: new Date(T + 11 * MIN).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			succeeding.claude.fetchDelayMs = 80;
			const slow = collectState({
				providers: succeeding,
				now: T + 10 * MIN,
				clock: () => T + 12 * MIN,
				force: true,
			});
			await Bun.sleep(10);
			await collectState({ providers: quick, now: T + 11 * MIN, force: true });
			await slow;
			expect((await loadCache()).entries[a.id]?.snapshot.windows[0]?.percent).toBe(36);
		});
	});

	test('the agent’s own reading is laid over the newest full reading, never replacing it', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{ key: 'seven_day', label: 'week', percent: 50 },
					{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 10 },
				],
				limitResets: [weekly],
				limitResetsReadAt: new Date(T).toISOString(),
			}));
			await collectState({ providers, now: T + 61_000, force: true });
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.local = {
				fetchedAtMs: T + 3 * MIN,
				windows: [{ key: 'seven_day', label: 'week', percent: 5 }],
			};
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 3.5 * MIN });
			await Bun.sleep(20);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			cache.entries[a.id] = {
				...entry,
				snapshot: {
					fetchedAt: new Date(T + 2 * MIN).toISOString(),
					windows: [
						{ key: 'seven_day', label: 'week', percent: 50 },
						{ key: 'weekly_scoped:Fable', label: 'Fable', percent: 95 },
					],
					limitResets: [],
					limitResetsReadAt: new Date(T + 2 * MIN).toISOString(),
				},
				fetchedAtMs: T + 2 * MIN,
				attemptedAtMs: T + 2 * MIN,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((x) => x.id === a.id)?.usage;
			const byLabel = Object.fromEntries(
				(shownA?.windows ?? []).map((window) => [window.label, window.percent]),
			);
			expect(byLabel).toEqual({ week: 5, Fable: 95 });
			expect(shownA?.limitResets).toEqual([]);
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows.find((w) => w.label === 'Fable')?.percent).toBe(95);
		});
	});

	test('an account whose login could not be confirmed still shows what is stored after a reset', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.readFailure = new Error('keychain locked');
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 30_000 });
			await Bun.sleep(20);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + 25_000).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				},
				T + 25_000,
			);
			const state = await pass;
			const shownA = state.providers.claude.accounts.find((x) => x.id === a.id)?.usage;
			expect(shownA?.windows[0]?.percent).toBe(0);
			expect(shownA?.error).toContain('could not confirm');
		});
	});

	test('the reading after a use keeps a later attempt’s failure and wait', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			const retryAt = new Date(T + 12 * MIN).toISOString();
			cache.entries[a.id] = {
				...entry,
				snapshot: {
					...entry.snapshot,
					error: 'too many requests',
					errorKind: 'throttled',
					retryAt,
				},
				attemptedAtMs: T + 2 * MIN,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				},
				T + MIN,
			);
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(0);
			expect(stored?.snapshot.error).toBe('too many requests');
			expect(stored?.snapshot.retryAt).toBe(retryAt);
			expect(stored?.attemptedAtMs).toBe(T + 2 * MIN);
		});
	});

	test('the status line keeps its reading and forecast, with a later attempt’s failure', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			cache.entries[a.id] = {
				...entry,
				snapshot: { ...entry.snapshot, error: 'too many requests', errorKind: 'throttled' },
				attemptedAtMs: T + MIN,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			const fullAt = new Date(T + 30 * MIN).toISOString();
			const shown = {
				fetchedAt: entry.snapshot.fetchedAt,
				windows: [{ key: 'seven_day', label: 'week', percent: 97, fullAt }],
			};
			const fresh = await freshUsage(a, 'claude', shown, T + 2 * MIN);
			expect(fresh?.error).toBe('too many requests');
			expect(fresh?.windows[0]?.fullAt).toBe(fullAt);
		});
	});

	test('the board brought up to date by a use stamps each account’s read when it begins', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			let calls = 0;
			const clock = () => (calls++ === 0 ? T + MIN : T + 2 * MIN);
			await useLimitReset('claude', a, 'weekly', providers, clock);
			expect((await loadCache()).entries[b.id]?.fetchedAtMs).toBe(T + 2 * MIN);
		});
	});

	test('a read after a use that is told to wait is recorded with its wait, and not repeated before', async () => {
		await withHome(async () => {
			const { providers, a, answer } = await holding([weekly]);
			providers.claude.useReset = async (credential, id, requestId) => {
				const outcome = await answer(credential, id, requestId);
				providers.claude.failures.set('A', new ServiceError('too many requests', 429, 10 * MIN));
				return outcome;
			};
			await useLimitReset('claude', a, 'weekly', providers, () => T + MIN);
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.errorKind).toBe('throttled');
			expect(stored?.snapshot.retryAt).toBe(new Date(T + 11 * MIN).toISOString());
			expect(stored?.attemptedAtMs).toBe(T + MIN);
			const reads = providers.claude.readsOf.get('A');
			await collectState({ providers, now: T + 2 * MIN });
			expect(providers.claude.readsOf.get('A')).toBe(reads);
		});
	});

	test('a list of resets is kept by when it was read, not by the numbers it came with', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T + 6 * MIN).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 60 }],
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 6 * MIN, force: true });
			await Bun.sleep(20);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			cache.entries[a.id] = {
				...entry,
				snapshot: {
					fetchedAt: new Date(T + 5 * MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 50 }],
					limitResets: [other],
					limitResetsReadAt: new Date(T + 5 * MIN).toISOString(),
				},
				fetchedAtMs: T + 5 * MIN,
				attemptedAtMs: T + 5 * MIN,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			await pass;
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(60);
			expect(stored?.snapshot.limitResets?.map((reset) => reset.id)).toEqual(['other']);
		});
	});

	test('the status line draws what the board would show now, not the numbers it saved', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'seven_day',
						label: 'week',
						percent: 97,
						resetsAt: new Date(T + MIN).toISOString(),
					},
				],
			}));
			await collectState({ providers, now: T + 61_000, force: true });
			const entry = (await loadCache()).entries[a.id];
			const shown = {
				fetchedAt: entry?.snapshot.fetchedAt ?? '',
				windows: [{ key: 'seven_day', label: 'week', percent: 54 }],
			};
			const before = await freshUsage(a, 'claude', shown, T + 30_000);
			expect(before?.windows[0]?.percent).toBe(97);
			const after = await freshUsage(a, 'claude', shown, T + 2 * MIN);
			expect(after?.windows[0]?.percent).toBe(0);
		});
	});

	test('the status line keeps the board’s word that the login in use could not be confirmed', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const entry = (await loadCache()).entries[a.id];
			const shown = {
				fetchedAt: entry?.snapshot.fetchedAt ?? '',
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
				error: 'could not confirm which login is in use - trying again shortly',
				errorKind: 'other' as const,
			};
			const fresh = await freshUsage(a, 'claude', shown, T + MIN);
			expect(fresh?.error).toContain('could not confirm');
		});
	});

	test('the status line keeps the board’s word that the login in use was signed out', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const entry = (await loadCache()).entries[a.id];
			const note = 'signed out - the login reached its time limit; sign in to it again';
			const shown = {
				fetchedAt: entry?.snapshot.fetchedAt ?? '',
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
				error: note,
				errorKind: 'other' as const,
			};
			const fresh = await freshUsage(a, 'claude', shown, T + MIN);
			expect(fresh?.error).toBe(note);
		});
	});

	test('a read asked for ahead of its turn reads the account and its list of resets on the next pass', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const reads = providers.claude.readsOf.get('A') ?? 0;
			await collectState({ providers, now: T + 10_000 });
			expect(providers.claude.readsOf.get('A')).toBe(reads);
			await readAgainSoon(a.id, T + 15_000);
			await collectState({ providers, now: T + 20_000 });
			expect(providers.claude.readsOf.get('A')).toBe(reads + 1);
			const given = providers.claude.previousGiven.at(-1);
			expect(given?.limitResetsStale).toBe(true);
			expect(given?.limitResetsReadAt).toBeDefined();
			await collectState({ providers, now: T + 25_000 });
			expect(providers.claude.readsOf.get('A')).toBe(reads + 1);
		});
	});

	test('the status line never prefers a reading shown as awaiting, however late it is dated', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const shown = {
				fetchedAt: new Date(T + 5 * MIN).toISOString(),
				windows: [],
				error: 'reading it again after a reset',
				errorKind: 'other' as const,
			};
			const fresh = await freshUsage(a, 'claude', shown, T + 6 * MIN);
			expect(fresh?.windows[0]?.percent).toBe(97);
		});
	});

	test('a limit read without its reset time takes it from a reading after the same reset, not before it', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'seven_day',
						label: 'week',
						percent: 97,
						resetsAt: new Date(T + 5 * MIN).toISOString(),
					},
				],
			}));
			await collectState({ providers, now: T + 61_000, force: true });
			expect((await loadCache()).entries[a.id]?.snapshot.windows[0]?.resetsAt).toBe(
				new Date(T + 5 * MIN).toISOString(),
			);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T + 2 * MIN).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 15 }],
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 2 * MIN + 1000, force: true });
			await Bun.sleep(20);
			const nextWeek = new Date(T + 7 * 24 * 60 * MIN).toISOString();
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + 2 * MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0, resetsAt: nextWeek }],
				},
				T + 2 * MIN,
			);
			await pass;
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(15);
			expect(stored?.snapshot.windows[0]?.resetsAt).toBe(nextWeek);
		});
	});

	test('a list of resets of unknown age never replaces one whose reading time is known', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T + 6 * MIN).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 60 }],
				limitResets: [weekly],
				limitResetsStale: true,
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 6 * MIN, force: true });
			await Bun.sleep(20);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			cache.entries[a.id] = {
				...entry,
				snapshot: {
					fetchedAt: new Date(T + 5 * MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 50 }],
					limitResets: [other],
					limitResetsReadAt: new Date(T + 5 * MIN).toISOString(),
				},
				fetchedAtMs: T + 5 * MIN,
				attemptedAtMs: T + 5 * MIN,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			await pass;
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(60);
			expect(stored?.snapshot.limitResets?.map((reset) => reset.id)).toEqual(['other']);
		});
	});

	test('a failed read after a reset on an account not read yet is kept, with its wait', async () => {
		await withHome(async () => {
			const providers = fakeProviders();
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await storeCredential(c, cred('C'));
			providers.claude.identities.set('C', { email: 'c@example.com', confirmed: true });
			providers.claude.readings.set('C', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			await recordAfterReset(
				c.id,
				failedReading(new ServiceError('too many requests', 429, 10 * MIN), T),
				T,
				T,
			);
			const stored = (await loadCache()).entries[c.id];
			expect(stored?.resetAtMs).toBe(T);
			expect(stored?.attemptedAtMs).toBe(T);
			expect(stored?.snapshot.retryAt).toBe(new Date(T + 10 * MIN).toISOString());
			await collectState({ providers, now: T + 3_000 });
			expect(providers.claude.readsOf.get('C') ?? 0).toBe(0);
		});
	});

	test('the status line shows a saved reading as it stands now when nothing newer is cached', async () => {
		await withHome(async () => {
			const shown = {
				fetchedAt: new Date(T - MIN).toISOString(),
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent: 98,
						resetsAt: new Date(T).toISOString(),
						fullAt: new Date(T + MIN).toISOString(),
					},
				],
			};
			const fresh = await freshUsage(
				{ id: 'not-in-cache', email: 'z@example.com' },
				'claude',
				shown,
				T + MIN,
			);
			expect(fresh?.windows[0]?.percent).toBe(0);
			expect(fresh?.windows[0]?.fullAt).toBeUndefined();
		});
	});

	test('the reading after a use keeps the reset time a reading after the same reset gave', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			const nextWeek = new Date(T + 7 * 24 * 60 * MIN).toISOString();
			cache.entries[a.id] = {
				...entry,
				snapshot: {
					fetchedAt: new Date(T + MIN + 5).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0, resetsAt: nextWeek }],
				},
				fetchedAtMs: T + MIN + 5,
				attemptedAtMs: T + MIN + 5,
				resetAtMs: T + MIN,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + MIN + 10).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 23 }],
				},
				T + MIN,
				T + MIN + 10,
			);
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(23);
			expect(stored?.snapshot.windows[0]?.resetsAt).toBe(nextWeek);
		});
	});

	test('a list asked to be read again is listed again until a list is read after the asking', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			cache.entries[a.id] = { ...entry, attemptedAtMs: T + 61_000, readSoonAt: T + 30_000 };
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			const reads = providers.claude.readsOf.get('A') ?? 0;
			await collectState({ providers, now: T + 3 * MIN, force: true });
			expect(providers.claude.readsOf.get('A')).toBe(reads + 1);
			expect(providers.claude.previousGiven.at(-1)?.limitResetsStale).toBe(true);
		});
	});

	test('the status line keeps the board’s unconfirmed-login word on a reading it sets aside', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			await saveSent(sentKey('claude', a), [
				{ resetId: 'weekly', requestId: 'r-1', at: T + MIN, used: true },
			]);
			const shown = {
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
				error: 'could not confirm which login is in use - trying again shortly',
				errorKind: 'other' as const,
			};
			const fresh = await freshUsage(
				{ id: 'not-in-cache', email: a.email },
				'claude',
				shown,
				T + 2 * MIN,
			);
			expect(fresh?.windows).toEqual([]);
			expect(fresh?.error).toContain('could not confirm');
		});
	});

	test('the reading after a use never takes a reset time from a reading before the reset', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			cache.entries[a.id] = {
				...entry,
				snapshot: {
					fetchedAt: new Date(T).toISOString(),
					windows: [
						{
							key: 'seven_day',
							label: 'week',
							percent: 97,
							resetsAt: new Date(T + 5 * MIN).toISOString(),
						},
					],
				},
				fetchedAtMs: T,
				attemptedAtMs: T,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
				},
				T + MIN,
			);
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(0);
			expect(stored?.snapshot.windows[0]?.resetsAt).toBeUndefined();
		});
	});

	test('a use is not sent once the limit it would clear has reset, though the fresh reading left out when', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const deadline = T + 5 * MIN;
			const { providers, a, used } = await holding([weekly, other], clock);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(clock.now).toISOString(),
				windows: [
					{
						key: 'seven_day',
						label: 'week',
						percent: 97,
						resetsAt: new Date(deadline).toISOString(),
					},
				],
				limitResets: [weekly, other],
				limitResetsReadAt: new Date(clock.now).toISOString(),
			}));
			clock.now = T + 61_000;
			await collectState({ providers, now: T + 61_000, force: true });
			expect((await loadCache()).entries[a.id]?.snapshot.windows[0]?.resetsAt).toBe(
				new Date(deadline).toISOString(),
			);
			clock.now = T + 2 * MIN;
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(clock.now).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
				limitResets: [weekly, other],
				limitResetsReadAt: new Date(clock.now).toISOString(),
			}));
			providers.claude.useReset = async (_credential, id) => {
				used.push(id);
				if (id === 'weekly') {
					clock.now = deadline + 1;
					return { used: false, refused: 'it was already used' };
				}
				return { used: true };
			};
			await useLimitReset('claude', a, ['weekly', 'other'], providers, () => clock.now);
			expect(used).toEqual(['weekly']);
		});
	});

	test('a read that answers after failed ones clears their failure, keeping the numbers it adds nothing to', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.failures.set('A', new ServiceError('unauthorized', 401));
			for (const at of [2, 4, 6]) {
				await collectState({ providers, now: T + at * MIN, force: true });
			}
			expect((await loadCache()).entries[a.id]?.snapshot.failedReads).toBe(3);
			providers.claude.failures.delete('A');
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T + 8 * MIN).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
			}));
			const state = await collectState({ providers, now: T + 8 * MIN, force: true });
			const shownA = state.providers.claude.accounts[0]?.usage;
			expect(shownA?.windows[0]?.percent).toBe(97);
			expect(shownA?.error).toBeUndefined();
			expect(shownA?.failedReads).toBeUndefined();
		});
	});

	test('the status line copies no forecast onto a limit that has reset since it was read', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'seven_day',
						label: 'week',
						percent: 97,
						resetsAt: new Date(T + 90_000).toISOString(),
					},
				],
			}));
			await collectState({ providers, now: T + 61_000, force: true });
			const entry = (await loadCache()).entries[a.id];
			const shown = {
				fetchedAt: entry?.snapshot.fetchedAt ?? '',
				windows: [
					{
						key: 'seven_day',
						label: 'week',
						percent: 0,
						fullAt: new Date(T + 30 * MIN).toISOString(),
					},
				],
			};
			const fresh = await freshUsage(a, 'claude', shown, T + 2 * MIN);
			expect(fresh?.windows[0]?.percent).toBe(0);
			expect(fresh?.windows[0]?.fullAt).toBeUndefined();
		});
	});

	/** A in use, with a stored reading whose week resets at `deadline`, read again at `now` before the use. */
	async function withDeadline(deadline: number, clock: { now: number }) {
		const held = await holding([weekly, other], clock);
		held.providers.claude.readings.set('A', () => ({
			fetchedAt: new Date(clock.now).toISOString(),
			windows: [
				{
					key: 'seven_day',
					label: 'week',
					percent: 97,
					resetsAt: new Date(deadline).toISOString(),
				},
			],
			limitResets: [weekly, other],
			limitResetsReadAt: new Date(clock.now).toISOString(),
		}));
		clock.now = T + 61_000;
		await collectState({ providers: held.providers, now: clock.now, force: true });
		clock.now = T + 2 * MIN;
		return held;
	}

	test('a reading that crosses the reset time while it is made, and leaves it out, sends nothing', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const deadline = T + 5 * MIN;
			const { providers, a, used } = await withDeadline(deadline, clock);
			providers.claude.readings.set('A', () => {
				clock.now = deadline + 1;
				return {
					fetchedAt: new Date(clock.now).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 97 }],
					limitResets: [weekly, other],
					limitResetsReadAt: new Date(clock.now).toISOString(),
				};
			});
			const result = await attempt(
				useLimitReset('claude', a, undefined, providers, () => clock.now),
			);
			expect(result).not.toBe('ok');
			expect(used).toEqual([]);
		});
	});

	test('a reset whose limit resets during the last lookups before it is sent is not sent', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const deadline = T + 5 * MIN;
			const { providers, a, used } = await withDeadline(deadline, clock);
			providers.claude.useReset = async (_credential, id, _requestId, stillWanted) => {
				clock.now = deadline + 1;
				if (stillWanted && !stillWanted()) throw new ResetNotSent('no longer wanted');
				used.push(id);
				return { used: true };
			};
			const result = await attempt(
				useLimitReset('claude', a, 'weekly', providers, () => clock.now),
			);
			expect(result).not.toBe('ok');
			expect(used).toEqual([]);
			expect((await loadSent())[sentKey('claude', a)] ?? []).toEqual([]);
		});
	});

	test('a reset time is carried only while it was still ahead when the account’s own read began', async () => {
		await withHome(async () => {
			const clock = { now: T };
			const deadline = T + 3 * MIN;
			const { providers, a } = await withDeadline(deadline, clock);
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(deadline + 5000).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 12 }],
			}));
			await collectState({
				providers,
				now: T + 2 * MIN + 50_000,
				clock: () => deadline + 5000,
				force: true,
			});
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(12);
			expect(stored?.snapshot.windows[0]?.resetsAt).toBeUndefined();
		});
	});

	test('a pass that began with nothing stored never lets an empty answer replace numbers stored meanwhile', async () => {
		await withHome(async () => {
			const providers = fakeProviders();
			const a = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
			);
			await updateRegistry((registry) => {
				registry.active.claude = a.id;
			});
			await storeCredential(a, cred('A'));
			providers.claude.identities.set('A', { email: 'a@example.com', confirmed: true });
			providers.claude.installed = cred('A');
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T + 2000).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 0 }],
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + 2000 });
			await Bun.sleep(20);
			const cache = await loadCache();
			cache.entries[a.id] = {
				snapshot: {
					fetchedAt: new Date(T + 1000).toISOString(),
					windows: [
						{
							key: 'seven_day',
							label: 'week',
							percent: 97,
							resetsAt: new Date(T + 5 * MIN).toISOString(),
						},
					],
				},
				fetchedAtMs: T + 1000,
				attemptedAtMs: T + 1000,
			};
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			const state = await pass;
			expect(state.providers.claude.accounts[0]?.usage?.windows[0]?.percent).toBe(97);
			expect((await loadCache()).entries[a.id]?.snapshot.windows[0]?.percent).toBe(97);
		});
	});

	test('a list read after a reset is kept, though the numbers that came with it were read before it', async () => {
		await withHome(async () => {
			const { providers, a } = await holding([weekly]);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await storeCredential(b, cred('B'));
			providers.claude.identities.set('B', { email: 'b@example.com', confirmed: true });
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 10 }],
			}));
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T + MIN).toISOString(),
				windows: [{ key: 'seven_day', label: 'week', percent: 80 }],
				limitResets: [other],
				limitResetsReadAt: new Date(T + 3 * MIN).toISOString(),
			}));
			providers.claude.fetchDelayMs = 60;
			const pass = collectState({ providers, now: T + MIN + 1000, force: true });
			await Bun.sleep(20);
			await recordAfterReset(
				a.id,
				{
					fetchedAt: new Date(T + 2 * MIN).toISOString(),
					windows: [{ key: 'seven_day', label: 'week', percent: 2 }],
				},
				T + 2 * MIN,
			);
			await pass;
			const stored = (await loadCache()).entries[a.id];
			expect(stored?.snapshot.windows[0]?.percent).toBe(2);
			expect(stored?.snapshot.limitResets?.map((reset) => reset.id)).toEqual(['other']);
		});
	});

	test('a read after a use refused as a bad login counts toward giving the login up', async () => {
		await withHome(async () => {
			const { a } = await holding([weekly]);
			const cache = await loadCache();
			const entry = cache.entries[a.id];
			if (!entry) throw new Error('no entry');
			cache.entries[a.id] = { ...entry, snapshot: { ...entry.snapshot, failedReads: 1 } };
			await writeJsonAtomic(usageCachePath(), cache, 0o600);
			await recordAfterReset(
				a.id,
				failedReading(new ServiceError('unauthorized', 401), T + MIN),
				T + MIN,
				T + MIN,
			);
			expect((await loadCache()).entries[a.id]?.snapshot.failedReads).toBe(2);
		});
	});

	test('the wait a read is told to keep counts from when its answer came, after a use and on a pass alike', async () => {
		await withHome(async () => {
			const clock = { now: T + MIN };
			const { providers, a, answer } = await holding([weekly], clock);
			providers.claude.useReset = async (credential, id, requestId) => {
				const outcome = await answer(credential, id, requestId);
				providers.claude.readings.set('A', () => {
					clock.now += 15_000;
					throw new ServiceError('too many requests', 429, 120_000);
				});
				return outcome;
			};
			await useLimitReset('claude', a, 'weekly', providers, () => clock.now);
			const afterUse = (await loadCache()).entries[a.id];
			expect(afterUse?.snapshot.retryAt).toBe(new Date(T + MIN + 135_000).toISOString());
			let calls = 0;
			await collectState({
				providers,
				now: T + 10 * MIN,
				clock: () => (calls++ === 0 ? T + 10 * MIN : T + 10 * MIN + 15_000),
				force: true,
			});
			const onPass = (await loadCache()).entries[a.id];
			expect(onPass?.snapshot.retryAt).toBe(new Date(T + 10 * MIN + 135_000).toISOString());
		});
	});

	test('a lost answer asked again but no longer wanted at the last moment stays as it was', async () => {
		await withHome(async () => {
			const clock = { now: T + MIN };
			const { providers, a, used } = await holding([weekly], clock);
			const lost = { resetId: 'weekly', title: 'Weekly reset', requestId: 'r-1', at: T };
			await saveSent(sentKey('claude', a), [lost]);
			providers.claude.useReset = async (_credential, id, _requestId, stillWanted) => {
				clock.now = Date.parse(weekly.expiresAt ?? '') + 1;
				if (stillWanted && !stillWanted()) throw new ResetNotSent('no longer wanted');
				used.push(id);
				return { used: true };
			};
			const result = await attempt(
				useLimitReset('claude', a, 'weekly', providers, () => clock.now),
			);
			expect(result).toContain('got no answer');
			expect(used).toEqual([]);
			expect((await loadSent())[sentKey('claude', a)]).toEqual([lost]);
		});
	});
});
