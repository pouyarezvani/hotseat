import { describe, expect, test } from 'bun:test';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tick } from '../src/core/auto.ts';
import {
	applyBrake,
	burnPoints,
	type GuardState,
	loadGuard,
	resumeBrake,
	runHook,
	updateGuard,
} from '../src/core/guard.ts';
import { readEvents } from '../src/core/log.ts';
import { loadRegistry, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { setSetting } from '../src/core/settings.ts';
import { holdSwitch } from '../src/core/switch-lock.ts';
import type { AccountRecord, State, UsageSnapshot } from '../src/core/types.ts';
import { storeCredential } from '../src/core/vault.ts';
import { cred, type FakeProvider, fakeProviders, tokenOf } from './fake-provider.ts';
import { withHome } from './helpers.ts';

const MIN = 60_000;
const SESSION = 'sess-1';

async function chat(home: string): Promise<{ transcript: string; helpers: string }> {
	const project = join(home, 'projects', 'p');
	const helpers = join(project, SESSION, 'subagents');
	await mkdir(helpers, { recursive: true });
	return { transcript: join(project, `${SESSION}.jsonl`), helpers };
}

async function helper(
	dir: string,
	id: string,
	options: {
		finished?: boolean;
		ageMinutes?: number;
		toolUseId?: string;
		transcript?: boolean;
	} = {},
): Promise<void> {
	const meta = join(dir, `agent-${id}.meta.json`);
	await writeFile(
		meta,
		JSON.stringify({
			agentType: 'general-purpose',
			toolUseId: options.toolUseId ?? `toolu_${id}`,
			spawnDepth: 1,
			...(options.finished ? { finished: true } : {}),
		}),
	);
	const when = new Date(Date.now() - (options.ageMinutes ?? 0) * MIN);
	await utimes(meta, when, when);
	if (options.transcript !== false) {
		const log = join(dir, `agent-${id}.jsonl`);
		await writeFile(log, '{}\n');
		await utimes(log, when, when);
	}
}

function payload(transcript: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		session_id: SESSION,
		transcript_path: transcript,
		tool_name: 'Agent',
		tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`,
		...extra,
	});
}

function denied(output: string): string | null {
	if (output === '') return null;
	const parsed = JSON.parse(output) as {
		hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
	};
	expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
	return parsed.hookSpecificOutput.permissionDecisionReason;
}

describe('the helper hook', () => {
	test('ignores other tools and writes nothing', async () => {
		await withHome(async (home) => {
			const { transcript } = await chat(home);
			expect(await runHook(payload(transcript, { tool_name: 'Bash' }))).toBe('');
			expect(await Bun.file(join(home, 'guard.json')).exists()).toBe(false);
		});
	});

	test('helpers may not start helpers', async () => {
		await withHome(async (home) => {
			const { transcript } = await chat(home);
			const reason = denied(await runHook(payload(transcript, { agent_id: 'a123' })));
			expect(reason).toContain('helpers may not start their own helpers');
		});
	});

	test('allows the fifth and refuses the sixth', async () => {
		await withHome(async (home) => {
			const { transcript, helpers } = await chat(home);
			for (const id of ['1', '2', '3', '4']) await helper(helpers, id);
			expect(await runHook(payload(transcript))).toBe('');
			await helper(helpers, '5', { toolUseId: 'toolu_5' });
			const reason = denied(await runHook(payload(transcript)));
			expect(reason).toContain('limit 5');
		});
	});

	test('finished helpers do not count', async () => {
		await withHome(async (home) => {
			const { transcript, helpers } = await chat(home);
			for (const id of ['1', '2', '3', '4', '5']) await helper(helpers, id, { finished: true });
			expect(await runHook(payload(transcript))).toBe('');
		});
	});

	test('silent helpers stop counting after 30 minutes', async () => {
		await withHome(async (home) => {
			const { transcript, helpers } = await chat(home);
			for (const id of ['1', '2', '3', '4', '5']) await helper(helpers, id, { ageMinutes: 31 });
			expect(await runHook(payload(transcript))).toBe('');
		});
	});

	test('a helper launched a moment ago counts before its transcript exists', async () => {
		await withHome(async (home) => {
			const { transcript, helpers } = await chat(home);
			for (const id of ['1', '2', '3', '4']) await helper(helpers, id);
			await helper(helpers, '5', { transcript: false });
			expect(denied(await runHook(payload(transcript)))).toContain('limit 5');
		});
	});

	test('parallel calls never exceed the chat limit', async () => {
		await withHome(async (home) => {
			const { transcript, helpers } = await chat(home);
			for (const id of ['1', '2', '3']) await helper(helpers, id);
			const outputs = await Promise.all(
				Array.from({ length: 6 }, () => runHook(payload(transcript))),
			);
			expect(outputs.filter((output) => output === '')).toHaveLength(2);
		});
	});

	test('a reservation ends when its helper appears', async () => {
		await withHome(async (home) => {
			const { transcript, helpers } = await chat(home);
			for (const id of ['1', '2', '3']) await helper(helpers, id);
			expect(await runHook(payload(transcript, { tool_use_id: 'toolu_new' }))).toBe('');
			await helper(helpers, 'new', { toolUseId: 'toolu_new' });
			expect(await runHook(payload(transcript))).toBe('');
			expect((await loadGuard()).reservations.map((r) => r.toolUseId)).not.toContain('toolu_new');
		});
	});

	test('resuming a finished helper with SendMessage is gated; messaging a running one is not', async () => {
		await withHome(async (home) => {
			const { transcript, helpers } = await chat(home);
			for (const id of ['1', '2', '3', '4', '5']) await helper(helpers, id);
			await helper(helpers, 'done', { finished: true });
			const resume = payload(transcript, { tool_name: 'SendMessage', tool_input: { to: 'done' } });
			expect(denied(await runHook(resume))).toContain('limit 5');
			const running = payload(transcript, { tool_name: 'SendMessage', tool_input: { to: '1' } });
			expect(await runHook(running)).toBe('');
			const other = payload(transcript, { tool_name: 'SendMessage', tool_input: { to: 'main' } });
			expect(await runHook(other)).toBe('');
		});
	});

	test('refuses while braked', async () => {
		await withHome(async (home) => {
			const { transcript } = await chat(home);
			await updateGuard((state) => {
				state.brakes.claude = { at: Date.now(), points: 30 };
			});
			expect(denied(await runHook(payload(transcript)))).toContain('Hotseat brake is on');
			expect(await runHook(payload(transcript, { tool_name: 'Bash' }))).toBe('');
		});
	});

	test('fails open on garbage and logs it', async () => {
		await withHome(async () => {
			expect(await runHook('not json')).toBe('');
			const events = await readEvents(1);
			expect(events.map((event) => event.kind)).toContain('hook-error');
		});
	});

	test('a held lock lets the call through within about a second and logs it', async () => {
		await withHome(async (home) => {
			const { transcript } = await chat(home);
			const { acquireLock } = await import('../src/core/fs.ts');
			const lock = await acquireLock(home, 1000, 'guard.lock');
			try {
				const started = Date.now();
				expect(await runHook(payload(transcript))).toBe('');
				expect(Date.now() - started).toBeLessThan(1600);
			} finally {
				await lock.release();
			}
			expect((await readEvents(1)).map((event) => event.kind)).toContain('hook-lock-timeout');
		});
	});
});

type Sample = GuardState['samples'][number];
const AT = (hhmm: string): number => Date.parse(`2026-11-04T${hhmm}:00-08:00`);
const WEEK = '2026-11-05T21:00:00Z';

function samples(account: string, readings: [string, number][], resetsAt = WEEK): Sample[] {
	return readings.map(([time, percent]) => ({
		t: AT(time),
		provider: 'claude',
		accountId: account,
		percent,
		resetsAt,
	}));
}

describe('burn', () => {
	test('last night trips at 12:35 AM', () => {
		const list = samples('ashby', [
			['00:01', 42],
			['00:05', 43],
			['00:24', 45],
			['00:31', 48],
			['00:35', 50],
		]);
		expect(burnPoints(list, 'claude', AT('00:35') - 60 * MIN, AT('00:35'))).toBe(8);
	});

	test('only readings inside the window count', () => {
		const list = samples('a', [
			['11:53', 25],
			['12:26', 26],
			['12:54', 27],
		]);
		expect(burnPoints(list, 'claude', AT('11:54'), AT('12:54'))).toBe(1);
	});

	test('switching accounts is not burn', () => {
		const list = [
			...samples('a', [
				['10:00', 50],
				['10:10', 52],
			]),
			...samples('b', [
				['10:20', 30],
				['10:30', 31],
			]),
		];
		expect(burnPoints(list, 'claude', AT('09:45'), AT('10:45'))).toBe(3);
	});

	test('a weekly reset is not burn', () => {
		const list = [
			...samples('a', [['10:00', 99]]),
			...samples(
				'a',
				[
					['10:10', 1],
					['10:20', 3],
				],
				'2026-11-12T21:00:00Z',
			),
		];
		expect(burnPoints(list, 'claude', AT('09:45'), AT('10:45'))).toBe(2);
	});

	test('a new week that reads higher than the old one is not burn', () => {
		const list = [
			...samples('a', [['10:00', 10]]),
			...samples(
				'a',
				[
					['10:10', 30],
					['10:20', 32],
				],
				'2026-11-12T21:00:00Z',
			),
		];
		expect(burnPoints(list, 'claude', AT('09:45'), AT('10:45'))).toBe(2);
	});

	test('the other provider is not counted', () => {
		const list = samples('a', [
			['10:00', 10],
			['10:30', 30],
		]).map((sample) => ({ ...sample, provider: 'codex' as const }));
		expect(burnPoints(list, 'claude', AT('09:45'), AT('10:45'))).toBe(0);
	});
});

function stateWith(percent: number, fetchedAt: number): State {
	const usage: UsageSnapshot = {
		fetchedAt: new Date(fetchedAt).toISOString(),
		windows: [{ key: 'seven_day', label: 'week', percent, resetsAt: WEEK }],
	};
	return {
		version: 1,
		updatedAt: new Date(fetchedAt).toISOString(),
		providers: {
			claude: {
				activeAccountId: 'acct-a',
				accounts: [
					{
						id: 'acct-a',
						provider: 'claude',
						email: 'a@example.com',
						slot: 1,
						disabled: false,
						addedAt: '2026-01-01T00:00:00Z',
						usage,
					},
				],
			},
			codex: { accounts: [] },
		},
	};
}

describe('the brake', () => {
	test('trips at the threshold, reports, and clears itself once spending calms down', async () => {
		await withHome(async () => {
			const settings = await setSetting('brakePoints', '25');
			const t0 = AT('09:00');
			await applyBrake(stateWith(40, t0), settings, t0);
			const reports = await applyBrake(stateWith(66, t0 + 30 * MIN), settings, t0 + 30 * MIN);
			expect(reports).toEqual([
				expect.objectContaining({ provider: 'claude', outcome: 'blocked' }),
			]);
			expect(reports[0]?.detail.startsWith('brake: Claude used 26 points')).toBe(true);
			expect((await loadGuard()).brakes.claude?.points).toBe(26);
			const later = t0 + 120 * MIN;
			await applyBrake(stateWith(67, later - 10 * MIN), settings, later - 10 * MIN);
			const calm = await applyBrake(stateWith(68, later), settings, later);
			expect(calm).toEqual([]);
			expect((await loadGuard()).brakes.claude).toBeUndefined();
			const kinds = (await readEvents(1, later)).map((event) => event.kind);
			expect(kinds).toContain('brake-trip');
			expect(kinds).toContain('brake-clear');
		});
	});

	test('stays off below the threshold', async () => {
		await withHome(async () => {
			const settings = await setSetting('brakePoints', '25');
			const t0 = AT('09:00');
			await applyBrake(stateWith(40, t0), settings, t0);
			expect(await applyBrake(stateWith(64, t0 + 50 * MIN), settings, t0 + 50 * MIN)).toEqual([]);
		});
	});

	test('setting the threshold to 0 turns the brake off and clears it', async () => {
		await withHome(async () => {
			await updateGuard((state) => {
				state.brakes.claude = { at: AT('09:00'), points: 30 };
			});
			const settings = await setSetting('brakePoints', '0');
			expect(await applyBrake(stateWith(99, AT('09:05')), settings, AT('09:05'))).toEqual([]);
			expect((await loadGuard()).brakes.claude).toBeUndefined();
		});
	});

	test('resume deletes the brake and logs it', async () => {
		await withHome(async () => {
			await updateGuard((state) => {
				state.brakes.claude = { at: Date.now(), points: 30 };
			});
			expect(await resumeBrake('all')).toEqual(['claude']);
			expect((await loadGuard()).brakes.claude).toBeUndefined();
			expect((await readEvents(1)).map((event) => event.kind)).toContain('brake-resume');
		});
	});

	test('a new brake waits for a switch in progress', async () => {
		await withHome(async () => {
			const settings = await setSetting('brakePoints', '25');
			const t0 = AT('09:00');
			await applyBrake(stateWith(40, t0), settings, t0);
			const held = await holdSwitch('claude');
			const tripping = applyBrake(stateWith(70, t0 + 10 * MIN), settings, t0 + 10 * MIN);
			await Bun.sleep(150);
			expect((await loadGuard()).brakes.claude).toBeUndefined();
			await held.release();
			await tripping;
			expect((await loadGuard()).brakes.claude).toBeDefined();
		});
	});
});

const T = Date.parse('2026-09-16T12:00:00Z');

function reading(percent: number): UsageSnapshot {
	return {
		fetchedAt: new Date(T).toISOString(),
		windows: [
			{
				key: 'seven_day',
				label: 'week',
				percent,
				resetsAt: new Date(T + 24 * 3_600_000).toISOString(),
			},
		],
	};
}

async function world(): Promise<{
	providers: { claude: FakeProvider; codex: FakeProvider };
	b: AccountRecord;
}> {
	const providers = fakeProviders();
	const a = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
	);
	const b = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
	);
	await updateRegistry((registry) => {
		registry.active.claude = a.id;
	});
	await storeCredential(a, cred('A'));
	await storeCredential(b, cred('B'));
	providers.claude.identities.set('A', { email: 'a@example.com' });
	providers.claude.identities.set('B', { email: 'b@example.com' });
	providers.claude.readings.set('A', () => reading(98));
	providers.claude.readings.set('B', () => reading(10));
	providers.claude.installed = cred('A');
	return { providers, b };
}

describe('the brake in the automatic pass', () => {
	test('a braked provider does not switch', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await updateGuard((state) => {
				state.brakes.claude = { at: T, points: 30 };
			});
			const reports = await tick({ providers, now: T, awake: async () => true });
			expect(reports.some((report) => report.outcome === 'switched')).toBe(false);
			expect(reports.some((report) => report.detail.startsWith('brake:'))).toBe(true);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('a switch decided before the brake does not land', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const reports = await tick({
				providers,
				now: T,
				awake: async () => true,
				beforeSwitchLock: async () => {
					await updateGuard((state) => {
						state.brakes.claude = { at: T, points: 30 };
					});
				},
			});
			expect(reports.some((report) => report.outcome === 'switched')).toBe(false);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
			expect((await loadRegistry()).active.claude).not.toBe(b.id);
		});
	});

	test('a brake that cannot save its state never stops switching', async () => {
		await withHome(async (home) => {
			const { providers } = await world();
			await mkdir(join(home, 'guard.json'));
			const reports = await tick({ providers, now: T, awake: async () => true });
			expect(reports.some((report) => report.outcome === 'switched')).toBe(true);
			expect((await readEvents(1)).map((event) => event.kind)).toContain('brake-error');
		});
	});

	test('without a brake the same pass switches', async () => {
		await withHome(async () => {
			const { providers } = await world();
			const reports = await tick({ providers, now: T, awake: async () => true });
			expect(reports.some((report) => report.outcome === 'switched')).toBe(true);
		});
	});
});
