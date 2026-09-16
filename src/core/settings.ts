import { readJson, writeJsonAtomic } from './fs.ts';
import { settingsPath } from './paths.ts';

export type Strategy = 'soonest-reset' | 'most-left';
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
	/** Rotate once the seated account passes this share of any window. */
	autoThresholdPercent: number;
	/** Seconds between auto-rotation checks. */
	autoIntervalSeconds: number;
	/** Seconds a rotation must wait before another may fire. */
	autoCooldownSeconds: number;
	/** A candidate must beat the seated account by this much to justify moving. */
	autoHysteresisPercent: number;
	/**
	 * Which account to move to. 'soonest-reset' spends the quota that is about
	 * to refresh anyway, and only counts accounts that still have room.
	 * 'most-left' jumps to whichever account has the most remaining.
	 */
	autoStrategy: Strategy;
	/** Which providers auto-rotation may touch. */
	autoProviders: string[];
	/** Seconds a usage reading is served from cache before a refetch. */
	refreshIntervalSeconds: number;
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
	autoIntervalSeconds: 120,
	autoCooldownSeconds: 300,
	autoHysteresisPercent: 10,
	autoStrategy: 'soonest-reset',
	autoProviders: ['claude', 'codex'],
	refreshIntervalSeconds: 180,
	barWidth: 14,
};

/** Values the menu offers directly, so the menu and the CLI agree on what is sane. */
export const THRESHOLD_CHOICES = [80, 90, 95, 98] as const;
export const REFRESH_CHOICES = [60, 180, 300, 600] as const;

interface Bound {
	min: number;
	max: number;
}

/**
 * Bounds exist because a value outside them breaks something concrete: polling
 * faster than a minute walks into the usage endpoint's own rate limit, and a
 * threshold above 99 leaves no room to land before the window closes.
 */
const BOUNDS: Partial<Record<keyof Settings, Bound>> = {
	autoThresholdPercent: { min: 50, max: 99 },
	autoIntervalSeconds: { min: 30, max: 3600 },
	autoCooldownSeconds: { min: 0, max: 86_400 },
	autoHysteresisPercent: { min: 0, max: 50 },
	refreshIntervalSeconds: { min: 60, max: 3600 },
	barWidth: { min: 6, max: 40 },
};

const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
	autoStrategy: ['soonest-reset', 'most-left'],
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
			Object.assign(merged, {
				[key]:
					typeof value === 'number' && Number.isFinite(value)
						? Math.min(bound.max, Math.max(bound.min, value))
						: DEFAULTS[key],
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
export function coerce(key: keyof Settings, raw: string): Settings[keyof Settings] {
	const current = DEFAULTS[key];
	if (typeof current === 'number') {
		const value = Number.parseFloat(raw);
		if (!Number.isFinite(value)) throw new Error(`${key} expects a number, got "${raw}"`);
		const bound = BOUNDS[key];
		if (bound && (value < bound.min || value > bound.max)) {
			throw new Error(`${key} must be between ${bound.min} and ${bound.max}`);
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
