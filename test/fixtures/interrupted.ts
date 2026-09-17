import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanUpEvenIfInterrupted } from '../../src/core/interrupt.ts';

// Stands in for a sign-in: makes a scratch folder, says where, then waits
// on something that never finishes, the way a sign-in waits on a browser.
const dir = await mkdtemp(join(tmpdir(), 'hotseat-interrupt-test-'));
await cleanUpEvenIfInterrupted(
	() => rm(dir, { recursive: true, force: true }),
	async () => {
		console.log(dir);
		await new Promise(() => undefined);
	},
);
