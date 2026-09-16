import { describe, expect, test } from 'bun:test';
import type { State } from '../src/core/types.ts';
import { buildTitle, type TitleOptions, titleText } from '../src/ui/title.ts';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const later = new Date(NOW + 3_600_000).toISOString();

const state: State = {
	version: 1,
	updatedAt: new Date(NOW).toISOString(),
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
					addedAt: later,
					usage: {
						fetchedAt: later,
						windows: [
							{ key: 'five_hour', label: '5h', percent: 32, resetsAt: later },
							{ key: 'seven_day', label: 'week', percent: 8, resetsAt: later },
							{ key: 'weekly_scoped:fable', label: 'Fable', percent: 13, resetsAt: later },
						],
					},
				},
			],
		},
		codex: {
			activeAccountId: 'b',
			accounts: [
				{
					id: 'b',
					provider: 'codex',
					email: 'someone@example.com',
					slot: 1,
					disabled: false,
					addedAt: later,
					usage: {
						fetchedAt: later,
						windows: [{ key: 'secondary', label: 'week', percent: 69, resetsAt: later }],
					},
				},
			],
		},
	},
};

const full: TitleOptions = {
	titleCompact: false,
	titleShowAccount: true,
	titlePercentage: 'all',
	titleShowModelLimits: true,
	titleShortenEmail: true,
};

describe('the menu bar title', () => {
	test('separates the service, the account and the numbers with a narrow bullet, never a dash', () => {
		const text = titleText(buildTitle(state, full));
		expect(text).toBe('Claude • pouya • 32% · 8% · 13%   Codex • someone • 69%');
		expect(text).not.toContain('—');
	});

	test('names the service on its own span so a renderer can show its mark instead', () => {
		const spans = buildTitle(state, full);
		expect(spans.filter((span) => span.provider).map((span) => [span.provider, span.text])).toEqual(
			[
				['claude', 'Claude'],
				['codex', 'Codex'],
			],
		);
	});

	test('compact keeps the full service names and the fullest number only', () => {
		expect(titleText(buildTitle(state, { ...full, titleCompact: true }))).toBe(
			'Claude 32%  Codex 69%',
		);
	});

	test('an account with no reading shows its name alone', () => {
		const bare: State = structuredClone(state);
		delete bare.providers.codex.accounts[0]?.usage;
		expect(titleText(buildTitle(bare, full))).toBe(
			'Claude • pouya • 32% · 8% · 13%   Codex • someone',
		);
	});

	test('the fullest limit only, and no percentages at all', () => {
		expect(titleText(buildTitle(state, { ...full, titlePercentage: 'worst' }))).toBe(
			'Claude • pouya • 32%   Codex • someone • 69%',
		);
		expect(titleText(buildTitle(state, { ...full, titlePercentage: 'none' }))).toBe(
			'Claude • pouya   Codex • someone',
		);
	});
});
