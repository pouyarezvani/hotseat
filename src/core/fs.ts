import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readJson<T>(path: string): Promise<T | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	return (await file.json()) as T;
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, '\t')}\n`, { mode });
	await rename(tmp, path);
}

export interface Lock {
	release(): Promise<void>;
}

export async function acquireLock(dir: string, timeoutMs = 10_000): Promise<Lock> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, 'lock');
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const handle = await open(path, 'wx', 0o600);
			await handle.writeFile(String(process.pid));
			await handle.close();
			return { release: () => rm(path, { force: true }) };
		} catch (error) {
			if (!isEexist(error)) throw error;
			if (await staleLock(path)) {
				await rm(path, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for lock at ${path}`);
			await Bun.sleep(50);
		}
	}
}

function isEexist(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function staleLock(path: string): Promise<boolean> {
	const text = await Bun.file(path)
		.text()
		.catch(() => '');
	const pid = Number.parseInt(text, 10);
	if (!Number.isFinite(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}
