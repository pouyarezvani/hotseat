import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanUpEvenIfInterrupted } from '../src/core/interrupt.ts';

const fixture = join(import.meta.dir, 'fixtures', 'interrupted.ts');

async function interruptedWith(
	signal: 'SIGTERM' | 'SIGINT',
): Promise<{ dir: string; code: number }> {
	const child = Bun.spawn(['bun', fixture], { stdout: 'pipe', stderr: 'ignore' });
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	const dir = new TextDecoder().decode(value).trim();
	expect((await stat(dir)).isDirectory()).toBe(true);
	child.kill(signal);
	return { dir, code: await child.exited };
}

describe('a sign-in that is interrupted', () => {
	test('cleans up after itself when it is stopped', async () => {
		const { dir, code } = await interruptedWith('SIGTERM');
		await expect(stat(dir)).rejects.toThrow();
		expect(code).toBe(143);
	});

	test('cleans up after itself on Control-C', async () => {
		const { dir, code } = await interruptedWith('SIGINT');
		await expect(stat(dir)).rejects.toThrow();
		expect(code).toBe(130);
	});

	test('cleans up once when nothing interrupts it, and passes the result through', async () => {
		let cleaned = 0;
		const result = await cleanUpEvenIfInterrupted(
			async () => {
				cleaned += 1;
			},
			async () => 'done',
		);
		expect(result).toBe('done');
		expect(cleaned).toBe(1);
	});

	test('cleans up when the work fails, and the failure still surfaces', async () => {
		let cleaned = 0;
		await expect(
			cleanUpEvenIfInterrupted(
				async () => {
					cleaned += 1;
				},
				async () => {
					throw new Error('sign-in ended with status 1');
				},
			),
		).rejects.toThrow(/status 1/);
		expect(cleaned).toBe(1);
	});
});
