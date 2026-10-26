import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanUpEvenIfInterrupted } from '../../src/core/interrupt.ts';

// Stands in for a sign-in: makes a scratch folder, says where, then waits
// on something that never finishes, the way a sign-in waits on a browser.
// With --fails-when-stopped, the wait fails as soon as clean-up starts and
// clean-up takes a while, the way stopping a sign-in ends its shell lookup
// before its scratch folder is gone.
const failsWhenStopped = process.argv.includes('--fails-when-stopped');
const dir = await mkdtemp(join(tmpdir(), 'hotseat-interrupt-test-'));
let stop = (): void => undefined;
await cleanUpEvenIfInterrupted(
	async () => {
		stop();
		if (failsWhenStopped) await Bun.sleep(300);
		await rm(dir, { recursive: true, force: true });
	},
	async () => {
		console.log(dir);
		await new Promise<void>((_, reject) => {
			if (failsWhenStopped) stop = () => reject(new Error('the sign-in was stopped'));
		});
	},
);
