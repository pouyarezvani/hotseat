import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enrollFromToken } from '../src/core/enroll.ts';
import { retryAfterMs, ServiceError } from '../src/core/errors.ts';
import { acquireLock, readJson, writeJsonAtomic } from '../src/core/fs.ts';
import { loadRegistry, setAlias, updateRegistry, upsertAccount } from '../src/core/registry.ts';
import { loadSettings } from '../src/core/settings.ts';
import { exportAccounts } from '../src/core/transfer.ts';
import { storeCredential } from '../src/core/vault.ts';
import { withHome } from './helpers.ts';

describe('files that are not what they should be', () => {
	test('a broken JSON file is named, with where it breaks, instead of a raw parse error', async () => {
		await withHome(async (home) => {
			const path = join(home, 'accounts.json');
			await writeFile(path, '{"version": 1, "accounts": [ {"provider": "claude", }');
			await expect(readJson(path)).rejects.toThrow(/accounts\.json is not valid JSON/);
			await expect(loadRegistry()).rejects.toThrow(/accounts\.json/);
		});
	});

	test('a failed write leaves no temporary file behind', async () => {
		await withHome(async (home) => {
			const dir = join(home, 'a-folder');
			await mkdir(dir);
			await expect(writeJsonAtomic(dir, { x: 1 })).rejects.toThrow();
			expect((await readdir(home)).filter((name) => name.includes('.tmp'))).toEqual([]);
		});
	});

	test('an export to a folder is refused before anything is written', async () => {
		await withHome(async (home) => {
			await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
			);
			await expect(exportAccounts(home)).rejects.toThrow(/is a folder - give a file name/);
			expect((await readdir(home)).filter((name) => name.includes('.tmp'))).toEqual([]);
		});
	});
});

describe('the lock', () => {
	test('a lock left by a process id that now belongs to someone else is stale', async () => {
		await withHome(async (home) => {
			await writeFile(join(home, 'lock'), `${process.pid} 1`);
			const lock = await acquireLock(home, 500);
			await lock.release();
		});
	});

	test('a lock held by a live process is respected', async () => {
		await withHome(async (home) => {
			const first = await acquireLock(home);
			await expect(acquireLock(home, 300)).rejects.toThrow(/timed out/);
			await first.release();
		});
	});
});

describe('naming and adding accounts', () => {
	test('a numeric or duplicate name is refused', async () => {
		await withHome(async () => {
			const a = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
			);
			const b = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
			);
			await updateRegistry((registry) => setAlias(registry, a.id, 'work'));
			await expect(updateRegistry((registry) => setAlias(registry, b.id, 'work'))).rejects.toThrow(
				/already called "work"/,
			);
			await expect(updateRegistry((registry) => setAlias(registry, b.id, '2'))).rejects.toThrow(
				/a number/,
			);
		});
	});

	test('a setup token does not quietly replace a full login', async () => {
		await withHome(async () => {
			const a = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
			);
			await storeCredential(a, {
				claudeAiOauth: {
					accessToken: 'full',
					refreshToken: 'r',
					expiresAt: 1,
					scopes: ['user:profile'],
				},
			});
			await expect(enrollFromToken('sk-ant-oat01-x', { email: 'a@example.com' })).rejects.toThrow(
				/fewer permissions/,
			);
			await enrollFromToken('sk-ant-oat01-x', { email: 'a@example.com', replace: true });
			const stored = (await loadRegistry()).accounts[0]?.login;
			expect(stored?.claudeAiOauth).toMatchObject({ accessToken: 'sk-ant-oat01-x' });
		});
	});
});

describe('a limit of its own per window, as a setting', () => {
	test('is off by default and bounded when set', async () => {
		await withHome(async (home) => {
			expect((await loadSettings()).autoThresholdFiveHour).toBe(0);
			expect((await loadSettings()).autoThresholdWeekly).toBe(0);
			await writeFile(
				join(home, 'settings.json'),
				JSON.stringify({ autoThresholdFiveHour: 97, autoThresholdWeekly: 20 }),
			);
			const settings = await loadSettings();
			expect(settings.autoThresholdFiveHour).toBe(97);
			expect(settings.autoThresholdWeekly).toBe(0);
		});
	});
});

describe('how long the service asks us to wait', () => {
	const now = Date.parse('2026-09-16T12:00:00Z');
	test.each([
		['120', 120_000],
		['0', 0],
		['Wed, 16 Sep 2026 12:05:00 GMT', 300_000],
		['garbage', undefined],
		[null, undefined],
	])('%s', (header, expected) => {
		expect(retryAfterMs(header, now)).toBe(expected);
	});

	test('a service error carries its status and the wait', () => {
		const error = new ServiceError('usage request failed with 429', 429, 5000);
		expect(error.status).toBe(429);
		expect(error.retryAfterMs).toBe(5000);
		expect(error.message).toBe('usage request failed with 429');
	});
});
