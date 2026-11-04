import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dayFile, logEvent, readEvents } from '../src/core/log.ts';
import { logDir } from '../src/core/paths.ts';
import { withHome } from './helpers.ts';

const DAY = 86_400_000;

describe('the event log', () => {
	test("an event lands in today's file and reads back", async () => {
		await withHome(async () => {
			const now = Date.now();
			await logEvent('brake-trip', { provider: 'claude', points: 26 }, now);
			const files = await readdir(logDir());
			expect(files).toEqual([dayFile(now)]);
			const events = await readEvents(1, now);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ kind: 'brake-trip', provider: 'claude', points: 26 });
		});
	});

	test('files older than 30 days are purged and newer ones kept', async () => {
		await withHome(async () => {
			const now = Date.now();
			await mkdir(logDir(), { recursive: true });
			await writeFile(join(logDir(), dayFile(now - 31 * DAY)), '{}\n');
			await writeFile(join(logDir(), dayFile(now - 29 * DAY)), '{}\n');
			await writeFile(join(logDir(), 'not-a-log.txt'), 'keep me');
			await logEvent('hook-allow', {}, now);
			const files = (await readdir(logDir())).sort();
			expect(files).toEqual([dayFile(now - 29 * DAY), dayFile(now), 'not-a-log.txt'].sort());
		});
	});

	test('a torn line is skipped rather than failing the read', async () => {
		await withHome(async () => {
			const now = Date.now();
			await mkdir(logDir(), { recursive: true });
			await writeFile(join(logDir(), dayFile(now)), '{"at":"x","kind":"ok"}\n{"at":');
			expect(await readEvents(1, now)).toEqual([{ at: 'x', kind: 'ok' }]);
		});
	});
});
