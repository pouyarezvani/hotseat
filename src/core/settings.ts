import { readJson, writeJsonAtomic } from './fs.ts';
import { settingsPath } from './paths.ts';

export type TitlePercentage = 'worst' | 'all' | 'none';

export interface Settings {
	version: 1;
	/** Shrink the menu bar button: short provider names and tighter separators. */
	titleCompact: boolean;
	/** Put the signed-in account's name in the menu bar title. */
	titleShowAccount: boolean;
	/** Which percentages the title carries. */
	titlePercentage: TitlePercentage;
	/** Include model-scoped weekly limits, such as a single model's own cap. */
	titleShowModelLimits: boolean;
	/** Shorten an account to the part before the @ in titles. */
	titleShortenEmail: boolean;
	/** Switch once the account in use passes this share of any counted window. */
	autoThresholdPercent: number;
	/** A limit of its own for the 5-hour window, or 0 to use the general one. */
	autoThresholdFiveHour: number;
	/** A limit of its own for the weekly window, or 0 to use the general one. */
	autoThresholdWeekly: number;
	/**
	 * Which models' own weekly limits count toward switching, by name, or
	 * 'all'. Empty means only the 5h and weekly windows count. A named model at
	 * its limit triggers a switch even with room in the overall windows.
	 */
	autoModelLimits: string[];
	/** Consecutive checks with no reading on the account in use before failing over. */
	autoUnhealthyTicks: number;
	/** Seconds between auto-rotation checks. */
	autoIntervalSeconds: number;
	/** Seconds a rotation must wait before another may fire. */
	autoCooldownSeconds: number;
	/** Which providers auto-rotation may touch. */
	autoProviders: string[];
	barWidth: number;
}

export const DEFAULTS: Settings = {
	version: 1,
	titleCompact: false,
	titleShowAccount: true,
	titlePercentage: 'all',
	titleShowModelLimits: true,
	titleShortenEmail: true,
	autoThresholdPercent: 90,
	autoThresholdFiveHour: 0,
	autoThresholdWeekly: 0,
	autoModelLimits: [],
	autoUnhealthyTicks: 3,
	autoIntervalSeconds: 120,
	autoCooldownSeconds: 300,
	autoProviders: ['claude', 'codex'],
	barWidth: 14,
};

interface Bound {
	min: number;
	max: number;
}

/**
 * Bounds exist because a value outside them breaks something concrete: a
 * threshold above 99 leaves no room to land before the limit closes, and a
 * check interval under 30 seconds serves nothing, since readings are never
 * refreshed faster than once a minute anyway.
 */
const BOUNDS: Partial<Record<keyof Settings, Bound>> = {
	autoThresholdPercent: { min: 50, max: 99 },
	autoThresholdFiveHour: { min: 0, max: 99 },
	autoThresholdWeekly: { min: 0, max: 99 },
	autoIntervalSeconds: { min: 30, max: 3600 },
	autoCooldownSeconds: { min: 0, max: 86_400 },
	autoUnhealthyTicks: { min: 1, max: 100 },
	barWidth: { min: 6, max: 40 },
};

const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
	titlePercentage: ['worst', 'all', 'none'],
};

export const SETTING_KEYS = Object.keys(DEFAULTS).filter(
	(key) => key !== 'version',
) as (keyof Settings)[];

export async function loadSettings(): Promise<Settings> {
	const stored = await readJson<Partial<Settings>>(settingsPath());
	const merged: Settings = { ...DEFAULTS, ...(stored ?? {}), version: 1 };
	for (const key of SETTING_KEYS) {
		const bound = BOUNDS[key];
		if (bound) {
			const value = merged[key];
			const clamped: number =
				typeof value === 'number' && Number.isFinite(value)
					? Math.min(bound.max, Math.max(bound.min, value))
					: DEFAULTS[key];
			Object.assign(merged, {
				[key]: isPerWindowThreshold(key) && clamped > 0 && clamped < 50 ? 0 : clamped,
			});
			continue;
		}
		const choices = CHOICES[key];
		if (choices && !choices.includes(String(merged[key]))) {
			Object.assign(merged, { [key]: DEFAULTS[key] });
			continue;
		}
		if (typeof DEFAULTS[key] === 'boolean' && typeof merged[key] !== 'boolean') {
			Object.assign(merged, { [key]: DEFAULTS[key] });
			continue;
		}
		if (Array.isArray(DEFAULTS[key])) {
			const value = merged[key];
			Object.assign(merged, {
				[key]: Array.isArray(value)
					? value.filter((item): item is string => typeof item === 'string')
					: DEFAULTS[key],
			});
		}
	}
	return merged;
}

export function describeSetting(key: keyof Settings): string {
	const choices = CHOICES[key];
	if (choices) return choices.join(' | ');
	const bound = BOUNDS[key];
	if (bound) return `${bound.min} to ${bound.max}`;
	if (typeof DEFAULTS[key] === 'boolean') return 'true | false';
	if (Array.isArray(DEFAULTS[key])) return 'comma-separated list';
	return 'value';
}

export function isSettingKey(value: string): value is keyof Settings {
	return (SETTING_KEYS as string[]).includes(value);
}

/** Parses a command-line string into the type the key actually holds. */
/** The two limits that may also be 0, meaning "the general limit applies". */
function isPerWindowThreshold(key: keyof Settings): boolean {
	return key === 'autoThresholdFiveHour' || key === 'autoThresholdWeekly';
}

export function coerce(key: keyof Settings, raw: string): Settings[keyof Settings] {
	const current = DEFAULTS[key];
	if (typeof current === 'number') {
		const value = Number.parseFloat(raw);
		if (!Number.isFinite(value)) throw new Error(`${key} expects a number, got "${raw}"`);
		const bound = BOUNDS[key];
		if (bound && (value < bound.min || value > bound.max)) {
			throw new Error(`${key} must be between ${bound.min} and ${bound.max}`);
		}
		if (isPerWindowThreshold(key) && value > 0 && value < 50) {
			throw new Error(`${key} is 0 for the general limit, or 50 to 99`);
		}
		return value;
	}
	if (typeof current === 'boolean') {
		if (raw === 'true' || raw === 'false') return raw === 'true';
		throw new Error(`${key} expects true or false, got "${raw}"`);
	}
	if (Array.isArray(current)) {
		return raw
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
	}
	const choices = CHOICES[key];
	if (choices && !choices.includes(raw)) {
		throw new Error(`${key} expects one of ${choices.join(', ')}, got "${raw}"`);
	}
	return raw as Settings[keyof Settings];
}

/** Writes only the touched key, so later default changes still reach this file. */
export async function setSetting(key: keyof Settings, raw: string): Promise<Settings> {
	const stored = (await readJson<Partial<Settings>>(settingsPath())) ?? {};
	await writeJsonAtomic(settingsPath(), { ...stored, version: 1, [key]: coerce(key, raw) });
	return loadSettings();
}

export async function resetSetting(key: keyof Settings): Promise<Settings> {
	const stored = (await readJson<Partial<Settings>>(settingsPath())) ?? {};
	delete stored[key];
	await writeJsonAtomic(settingsPath(), { ...stored, version: 1 });
	return loadSettings();
}
