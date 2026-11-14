import { afterEach, describe, expect, test } from 'bun:test';
import {
	readSummary,
	type ServiceStatus,
	STATUS_EVERY_MS,
	serviceStatuses,
	worthShowing,
} from '../src/core/service-status.ts';
import { withHome } from './helpers.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const NOW = Date.parse('2026-11-14T12:00:00Z');
const CLAUDE = { url: 'https://status.claude.com', component: 'Claude Code' };
const OPENAI = { url: 'https://status.openai.com' };

function fakeFetch(answer: (url: string) => Response): string[] {
	const calls: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request): Promise<Response> => {
			calls.push(String(input));
			return answer(String(input));
		},
		{ preconnect: () => undefined },
	) as unknown as typeof fetch;
	return calls;
}

const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value), { status });

describe('reading a status page', () => {
	test('a page that lists the agent apart is read for that part alone', () => {
		expect(
			readSummary(
				{
					status: { indicator: 'minor', description: 'Partially Degraded Service' },
					components: [
						{ name: 'claude.ai', status: 'degraded_performance' },
						{ name: 'Claude Code', status: 'operational' },
					],
					incidents: [{ name: 'Slow replies on claude.ai', status: 'investigating' }],
				},
				CLAUDE,
			),
		).toEqual({ level: 'ok', summary: 'Claude Code is operational' });
	});

	test('trouble in that part is named, with the incidents still open', () => {
		expect(
			readSummary(
				{
					components: [{ name: 'Claude Code', status: 'partial_outage' }],
					incidents: [
						{ name: 'Elevated errors', status: 'identified' },
						{ name: 'An old one', status: 'resolved' },
					],
				},
				CLAUDE,
			),
		).toEqual({ level: 'major', summary: 'Claude Code is partial outage: Elevated errors' });
	});

	test('a page with no entry for the agent is read as a whole, with what the trouble is about', () => {
		expect(
			readSummary(
				{
					status: { indicator: 'minor', description: 'Partial System Degradation' },
					incidents: [{ name: 'Delayed Costs Data in the Compliance API', status: 'monitoring' }],
				},
				OPENAI,
			),
		).toEqual({
			level: 'minor',
			summary: 'Partial System Degradation: Delayed Costs Data in the Compliance API',
		});
		expect(
			readSummary(
				{ status: { indicator: 'none', description: 'All Systems Operational' } },
				OPENAI,
			),
		).toEqual({ level: 'ok', summary: 'All Systems Operational' });
	});

	test('an answer that says nothing readable is not turned into a status', () => {
		expect(readSummary({}, OPENAI)).toBeUndefined();
		expect(readSummary({ components: [] }, CLAUDE)).toBeUndefined();
		expect(
			readSummary({ components: [{ name: 'Claude Code', status: 'on_fire' }] }, CLAUDE),
		).toBeUndefined();
	});
});

describe('asking the status pages', () => {
	const fine = { status: { indicator: 'none', description: 'All Systems Operational' } };

	test('only the services that have a status page are asked, each at its own page', async () => {
		await withHome(async () => {
			const calls = fakeFetch(() => json(fine));
			const got = await serviceStatuses(['codex', 'antigravity', 'grok'], NOW);
			expect(calls).toEqual(['https://status.openai.com/api/v2/summary.json']);
			expect(got.codex?.level).toBe('ok');
			expect(got.antigravity).toBeUndefined();
		});
	});

	test('each answer says whether the page lists the agent on its own', async () => {
		await withHome(async () => {
			fakeFetch((url) =>
				url.includes('claude')
					? json({ components: [{ name: 'Claude Code', status: 'operational' }] })
					: json(fine),
			);
			const got = await serviceStatuses(['claude', 'codex'], NOW);
			expect(got.claude?.scoped).toBe(true);
			expect(got.codex?.scoped).toBe(false);
		});
	});

	test('a page read under five minutes ago is not read again', async () => {
		await withHome(async () => {
			const calls = fakeFetch(() => json(fine));
			await serviceStatuses(['codex'], NOW);
			await serviceStatuses(['codex'], NOW + STATUS_EVERY_MS - 1);
			expect(calls.length).toBe(1);
			await serviceStatuses(['codex'], NOW + STATUS_EVERY_MS);
			expect(calls.length).toBe(2);
		});
	});

	test('a page that cannot be reached keeps what it last said', async () => {
		await withHome(async () => {
			fakeFetch(() =>
				json({ status: { indicator: 'major', description: 'Major Outage' }, incidents: [] }),
			);
			await serviceStatuses(['codex'], NOW);
			fakeFetch(() => json({}, 503));
			const got = await serviceStatuses(['codex'], NOW + STATUS_EVERY_MS);
			expect(got.codex?.level).toBe('major');
		});
	});

	test('a page never reached says nothing, and does not fail the board', async () => {
		await withHome(async () => {
			fakeFetch(() => {
				throw new Error('offline');
			});
			expect(await serviceStatuses(['claude', 'codex'], NOW)).toEqual({});
		});
	});
});

describe('which trouble is worth showing', () => {
	const status = (level: ServiceStatus['level'], scoped: boolean): ServiceStatus => ({
		level,
		scoped,
		summary: 's',
		url: 'u',
		checkedAt: 'x',
	});

	test("any trouble in the agent's own entry", () => {
		expect(worthShowing(status('minor', true))).toBe(true);
		expect(worthShowing(status('maintenance', true))).toBe(true);
	});

	test('only an outage on a page that covers a whole company', () => {
		expect(worthShowing(status('minor', false))).toBe(false);
		expect(worthShowing(status('maintenance', false))).toBe(false);
		expect(worthShowing(status('major', false))).toBe(true);
		expect(worthShowing(status('critical', false))).toBe(true);
	});

	test('nothing when all is well, or when there is no answer', () => {
		expect(worthShowing(status('ok', true))).toBe(false);
		expect(worthShowing(undefined)).toBe(false);
	});
});
