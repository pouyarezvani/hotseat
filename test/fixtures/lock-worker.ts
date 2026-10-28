import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '../../src/core/fs.ts';

// Takes the contended lock again and again. Inside it, checks that no other
// live process is inside too, names itself as the one inside, waits a moment,
// then leaves. Anything seen inside that is still alive is written down.
const [home = '', rounds = '20'] = process.argv.slice(2);
const occupant = join(home, 'occupant');
const violations = join(home, 'violations');

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

for (let round = 0; round < Number(rounds); round += 1) {
	const lock = await acquireLock(home, 60_000, 'contended.lock');
	const inside = Number.parseInt(
		await Bun.file(occupant)
			.text()
			.catch(() => ''),
		10,
	);
	if (Number.isFinite(inside) && inside !== process.pid && alive(inside)) {
		await appendFile(violations, `${process.pid} found ${inside} inside\n`);
	}
	await writeFile(occupant, String(process.pid));
	await Bun.sleep(3);
	await writeFile(occupant, '');
	await lock.release();
}
