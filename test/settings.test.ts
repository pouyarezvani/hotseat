import { describe, expect, test } from 'bun:test';
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

	test('switching automatically is off until asked for', () => {
		expect(DEFAULTS.autoEnabled).toBe(false);
	});

	test('the default strategy spends the quota that resets soonest', () => {
		expect(DEFAULTS.autoStrategy).toBe('soonest-reset');
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
			await setSetting('autoEnabled', 'true');
			const stored = await readJson<Record<string, unknown>>(settingsPath());
			expect(Object.keys(stored ?? {}).sort()).toEqual(['autoEnabled', 'version']);
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
			await setSetting('autoEnabled', 'true');
			await setSetting('barWidth', '20');
			const settings = await loadSettings();
			expect(settings.autoEnabled).toBe(true);
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
		expect(() => coerce('autoEnabled', 'yes')).toThrow(/true or false/);
		expect(coerce('autoEnabled', 'true')).toBe(true);
		expect(coerce('autoEnabled', 'false')).toBe(false);
	});

	test('a choice key refuses an unknown choice and names the valid ones', () => {
		expect(() => coerce('autoStrategy', 'whatever')).toThrow(/soonest-reset, most-left/);
	});

	test('a list key splits on commas and drops blanks', () => {
		expect(coerce('autoProviders', 'claude, codex ,')).toEqual(['claude', 'codex']);
	});

	test('an unknown key is not a setting', () => {
		expect(isSettingKey('autoEnabled')).toBe(true);
		expect(isSettingKey('nonsense')).toBe(false);
	});

	test('a read below the polling floor would trip the rate limit, so it is refused', () => {
		expect(() => coerce('refreshIntervalSeconds', '5')).toThrow(/between 60 and 3600/);
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
				JSON.stringify({ version: 1, autoEnabled: 'sure', barWidth: 'wide' }),
			);
			const settings = await loadSettings();
			expect(settings.autoEnabled).toBe(DEFAULTS.autoEnabled);
			expect(settings.barWidth).toBe(DEFAULTS.barWidth);
		});
	});

	test('an unknown choice falls back to its default', async () => {
		await withHome(async () => {
			await Bun.write(settingsPath(), JSON.stringify({ version: 1, autoStrategy: 'sideways' }));
			expect((await loadSettings()).autoStrategy).toBe(DEFAULTS.autoStrategy);
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
