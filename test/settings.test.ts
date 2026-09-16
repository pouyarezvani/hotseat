import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readJson } from '../src/core/fs.ts';
import { settingsPath } from '../src/core/paths.ts';
import {
	coerce,
	DEFAULTS,
	isSettingKey,
	loadSettings,
	resetSetting,
	SETTING_KEYS,
	setSetting,
} from '../src/core/settings.ts';
import { withHome } from './helpers.ts';

describe('defaults', () => {
	test('a fresh install reads every default', async () => {
		await withHome(async () => {
			expect(await loadSettings()).toEqual(DEFAULTS);
		});
	});

	test('by default no single model limit counts toward switching', () => {
		expect(DEFAULTS.autoModelLimits).toEqual([]);
	});

	test('there is no way to turn switching off, because switching is the point', () => {
		expect(SETTING_KEYS as string[]).not.toContain('autoEnabled');
	});
});

describe('changing a setting', () => {
	test('a change is readable afterwards', async () => {
		await withHome(async () => {
			await setSetting('autoThresholdPercent', '85');
			expect((await loadSettings()).autoThresholdPercent).toBe(85);
		});
	});

	test('only the changed key is written, so later defaults still reach you', async () => {
		await withHome(async () => {
			await setSetting('barWidth', '20');
			const stored = await readJson<Record<string, unknown>>(settingsPath());
			expect(Object.keys(stored ?? {}).sort()).toEqual(['barWidth', 'version']);
		});
	});

	test('resetting a key restores its default', async () => {
		await withHome(async () => {
			await setSetting('barWidth', '30');
			await resetSetting('barWidth');
			expect((await loadSettings()).barWidth).toBe(DEFAULTS.barWidth);
		});
	});

	test('two changes both survive', async () => {
		await withHome(async () => {
			await setSetting('autoThresholdPercent', '85');
			await setSetting('barWidth', '20');
			const settings = await loadSettings();
			expect(settings.autoThresholdPercent).toBe(85);
			expect(settings.barWidth).toBe(20);
		});
	});
});

describe('rejecting bad values', () => {
	test('a threshold outside its range is refused, with the range in the message', () => {
		expect(() => coerce('autoThresholdPercent', '150')).toThrow(/between 50 and 99/);
		expect(() => coerce('autoThresholdPercent', '10')).toThrow(/between 50 and 99/);
	});

	test('a number key refuses text', () => {
		expect(() => coerce('barWidth', 'wide')).toThrow(/expects a number/);
	});

	test('a yes-or-no key refuses anything else', () => {
		expect(() => coerce('titleCompact', 'yes')).toThrow(/true or false/);
		expect(coerce('titleCompact', 'true')).toBe(true);
		expect(coerce('titleCompact', 'false')).toBe(false);
	});

	test('a choice key refuses an unknown choice and names the valid ones', () => {
		expect(() => coerce('titlePercentage', 'whatever')).toThrow(/worst, all, none/);
	});

	test('a list key splits on commas and drops blanks', () => {
		expect(coerce('autoProviders', 'claude, codex ,')).toEqual(['claude', 'codex']);
		expect(coerce('autoModelLimits', 'Fable, Opus')).toEqual(['Fable', 'Opus']);
		expect(coerce('autoModelLimits', '')).toEqual([]);
	});

	test('an unknown key is not a setting', () => {
		expect(isSettingKey('autoThresholdPercent')).toBe(true);
		expect(isSettingKey('nonsense')).toBe(false);
	});

	test('the check interval cannot go under what would trip the rate limit', () => {
		expect(() => coerce('autoIntervalSeconds', '5')).toThrow(/between 30 and 3600/);
	});
});

describe('surviving a damaged settings file', () => {
	test('an out-of-range number on disk is clamped rather than obeyed', async () => {
		await withHome(async () => {
			await Bun.write(settingsPath(), JSON.stringify({ version: 1, autoThresholdPercent: 500 }));
			expect((await loadSettings()).autoThresholdPercent).toBe(99);
		});
	});

	test('a value of the wrong type falls back to its default', async () => {
		await withHome(async () => {
			await Bun.write(
				settingsPath(),
				JSON.stringify({ version: 1, titleCompact: 'sure', barWidth: 'wide' }),
			);
			const settings = await loadSettings();
			expect(settings.titleCompact).toBe(DEFAULTS.titleCompact);
			expect(settings.barWidth).toBe(DEFAULTS.barWidth);
		});
	});

	test('an unknown choice falls back to its default', async () => {
		await withHome(async () => {
			await Bun.write(settingsPath(), JSON.stringify({ version: 1, titlePercentage: 'sideways' }));
			expect((await loadSettings()).titlePercentage).toBe(DEFAULTS.titlePercentage);
		});
	});

	test('every key still has a usable value after a damaged file', async () => {
		await withHome(async () => {
			await Bun.write(settingsPath(), JSON.stringify({ version: 1, autoIntervalSeconds: -9000 }));
			const settings = await loadSettings();
			for (const key of SETTING_KEYS) {
				expect(settings[key]).toBeDefined();
			}
			expect(settings.autoIntervalSeconds).toBeGreaterThanOrEqual(30);
		});
	});
});

describe('a settings file with the wrong shapes', () => {
	test('a list setting holding something other than a list falls back to its default', async () => {
		await withHome(async (home) => {
			await Bun.write(
				join(home, 'settings.json'),
				JSON.stringify({ autoProviders: 5, autoModelLimits: ['fable', 3, null] }),
			);
			const settings = await loadSettings();
			expect(settings.autoProviders).toEqual(['claude', 'codex']);
			expect(settings.autoModelLimits).toEqual(['fable']);
		});
	});
});
