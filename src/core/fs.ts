import { link, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Reads a JSON file, or nothing when it does not exist. A file that is not
 * JSON is named in the error, because "Unexpected token" on its own sends
 * someone hunting through every file hotseat keeps.
 */
export async function readJson<T>(path: string): Promise<T | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	const text = await file.text();
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		const why =
			error instanceof Error ? error.message.replace(/^JSON Parse error: /, '') : String(error);
		throw new Error(`${basename(path)} is not valid JSON (${why}) - fix it or move it aside`);
	}
}

/** Like readJson, but a file that is not JSON reads as nothing. For caches. */
export async function readJsonLoose<T>(path: string): Promise<T | null> {
	try {
		return await readJson<T>(path);
	} catch {
		return null;
	}
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
	const existing = await stat(path).catch(() => null);
	if (existing?.isDirectory()) throw new Error(`${path} is a folder - give a file name`);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(value, null, '\t')}\n`, { mode });
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

export interface Lock {
	release(): Promise<void>;
}

/**
 * When a process started, as the system prints it. A process id alone is not
 * enough to know a lock's holder is still alive: the id is reused once that
 * process ends, and a lock left by a crash would then look held forever.
 */
async function startedAt(pid: number): Promise<string> {
	const proc = Bun.spawn(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return text.trim().replace(/\s+/g, ' ');
}

export async function acquireLock(dir: string, timeoutMs = 10_000, name = 'lock'): Promise<Lock> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, name);
	const deadline = Date.now() + timeoutMs;
	const own = `${process.pid} ${await startedAt(process.pid)}`;
	// The lock appears already naming its holder: written aside, then linked
	// into place, which fails if the lock exists. Created empty and filled
	// after, a lock is briefly nameless, and another caller reading it then
	// takes it for abandoned and holds it too.
	const draft = `${path}.${process.pid}.${crypto.randomUUID()}`;
	await writeFile(draft, own, { mode: 0o600 });
	try {
		for (;;) {
			try {
				await link(draft, path);
				return {
					release: async () => {
						// Only ever remove a lock this process wrote.
						const holder = await Bun.file(path)
							.text()
							.catch(() => '');
						if (holder === own) await rm(path, { force: true });
					},
				};
			} catch (error) {
				if (!isEexist(error)) throw error;
				const stale = await staleLock(path);
				if (stale !== null) {
					await removeIfUnchanged(path, stale);
					continue;
				}
				if (Date.now() > deadline) throw new Error(`timed out waiting for lock at ${path}`);
				await Bun.sleep(25);
			}
		}
	} finally {
		await rm(draft, { force: true });
	}
}

/**
 * Removes an abandoned lock, unless someone replaced it since it was judged
 * abandoned: that lock is live, so it goes back where it was.
 */
async function removeIfUnchanged(path: string, seen: string): Promise<void> {
	const aside = `${path}.stale.${process.pid}.${crypto.randomUUID()}`;
	try {
		await rename(path, aside);
	} catch {
		return;
	}
	const moved = await Bun.file(aside)
		.text()
		.catch(() => seen);
	if (moved !== seen) await link(aside, path).catch(() => undefined);
	await rm(aside, { force: true });
}

function isEexist(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function staleLock(path: string): Promise<string | null> {
	const text = await Bun.file(path)
		.text()
		.catch(() => null);
	if (text === null) return null;
	const [pidText, ...rest] = text.trim().split(' ');
	const pid = Number.parseInt(pidText ?? '', 10);
	if (!Number.isFinite(pid) || pid <= 0) return text;
	try {
		process.kill(pid, 0);
	} catch (error) {
		// Not ours to signal, but alive all the same.
		if ((error as { code?: string }).code !== 'EPERM') return text;
	}
	const started = rest.join(' ');
	if (started.length === 0) return null;
	return (await startedAt(pid)) !== started ? text : null;
}
