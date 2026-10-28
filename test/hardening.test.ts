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
import { fakeProviders } from './fake-provider.ts';
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

const lockWorker = join(import.meta.dir, 'fixtures', 'lock-worker.ts');

describe('the lock', () => {
	test('a holder that is killed gives up its lock at once', async () => {
		await withHome(async (home) => {
			const holder = Bun.spawn([process.execPath, lockWorker, home, '1000000'], {
				stdout: 'ignore',
				stderr: 'ignore',
			});
			for (let tries = 0; tries < 200; tries += 1) {
				if (
					(
						await Bun.file(join(home, 'occupant'))
							.text()
							.catch(() => '')
					).length > 0
				)
					break;
				await Bun.sleep(10);
			}
			holder.kill('SIGKILL');
			await holder.exited;
			const lock = await acquireLock(home, 1_000, 'contended.lock');
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

describe('the lock under contention', () => {
	test('is held by one caller at a time, however many ask at once', async () => {
		await withHome(async (home) => {
			let inside = 0;
			let most = 0;
			await Promise.all(
				Array.from({ length: 12 }, async () => {
					const lock = await acquireLock(home, 20_000, 'contended.lock');
					inside += 1;
					most = Math.max(most, inside);
					await Bun.sleep(5);
					inside -= 1;
					await lock.release();
				}),
			);
			expect(most).toBe(1);
		});
	});

	test('is held by one process at a time, even while holders are killed inside it and others take over', async () => {
		await withHome(async (home) => {
			const workers = Array.from({ length: 16 }, () =>
				Bun.spawn([process.execPath, lockWorker, home, '15'], {
					stdout: 'ignore',
					stderr: 'ignore',
				}),
			);
			for (let kills = 0; kills < 12; kills += 1) {
				await Bun.sleep(40);
				const inside = Number.parseInt(
					await Bun.file(join(home, 'occupant'))
						.text()
						.catch(() => ''),
					10,
				);
				const worker = workers.find((each) => each.pid === inside);
				worker?.kill('SIGKILL');
			}
			await Promise.all(workers.map((worker) => worker.exited));
			expect(
				await Bun.file(join(home, 'violations'))
					.text()
					.catch(() => ''),
			).toBe('');
		});
	}, 60_000);
});

describe('writing a file whole', () => {
	test('many writes to one file at the same moment all land, and leave it whole', async () => {
		await withHome(async (home) => {
			const path = join(home, 'busy.json');
			const results = await Promise.allSettled(
				Array.from({ length: 40 }, (_, index) => writeJsonAtomic(path, { index })),
			);
			expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
			expect(typeof (await readJson<{ index: number }>(path))?.index).toBe('number');
			expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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
			const providers = fakeProviders();
			await expect(
				enrollFromToken('sk-ant-oat01-x', { email: 'a@example.com', providers }),
			).rejects.toThrow(/fewer permissions/);
			await enrollFromToken('sk-ant-oat01-x', { email: 'a@example.com', replace: true, providers });
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

describe('the tests themselves', () => {
	test('cannot reach a real service', async () => {
		await expect(fetch('https://api.anthropic.com/api/oauth/profile')).rejects.toThrow(
			'a test tried to reach https://api.anthropic.com/api/oauth/profile',
		);
	});

	test("cannot read this Mac's keychain, which holds the real login", async () => {
		const { readKeychain } = await import('../src/providers/claude/keychain.ts');
		expect(await readKeychain()).toBeNull();
	});
});
