import { dlopen, FFIType, read } from 'bun:ffi';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
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
		throw new NotJson(`${basename(path)} is not valid JSON (${why}) - fix it or move it aside`);
	}
}

class NotJson extends Error {}

/** Like readJson, but a file that is not JSON reads as nothing. For caches. */
export async function readJsonLoose<T>(path: string): Promise<T | null> {
	try {
		return await readJson<T>(path);
	} catch {
		return null;
	}
}

/**
 * Like readJson, but a file that is not JSON, or that went away while it was
 * read, reads as nothing. A file that cannot be read at all still throws: for
 * files written by someone else whose absence says that nothing is running.
 */
export async function readJsonUnlessGarbled<T>(path: string): Promise<T | null> {
	return readJson<T>(path).catch((error: unknown) => {
		if (error instanceof NotJson) return null;
		return orIfMissing(null)(error);
	});
}

/**
 * For a `.catch`: a file or folder that is not there reads as `fallback`, and
 * any other failure, such as one that cannot be opened, is thrown on.
 */
export function orIfMissing<T>(fallback: T): (error: unknown) => T {
	return (error) => {
		if ((error as { code?: string } | null)?.code === 'ENOENT') return fallback;
		throw error;
	};
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
	const existing = await stat(path).catch(() => null);
	if (existing?.isDirectory()) throw new Error(`${path} is a folder - give a file name`);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(value, null, '\t')}\n`, { mode, flag: 'wx' });
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}
}

export interface Lock {
	release(): Promise<void>;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const EWOULDBLOCK = process.platform === 'darwin' ? 35 : 11;
const ERRNO = process.platform === 'darwin' ? '__error' : '__errno_location';

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	[ERRNO]: { args: [], returns: FFIType.ptr },
});

function lastErrno(): number {
	const where = libc.symbols[ERRNO]?.();
	return where ? read.i32(where, 0) : 0;
}

/**
 * Takes an exclusive lock on a file in `dir`, waiting up to `timeoutMs` for
 * whoever holds it. The lock is the kernel's, held on an open file: it is
 * released when the file is closed, including when the holder crashes or is
 * killed, so there is never an abandoned lock to judge or take over.
 */
export async function acquireLock(dir: string, timeoutMs = 10_000, name = 'lock'): Promise<Lock> {
	const locks = join(dir, 'locks');
	await mkdir(locks, { recursive: true, mode: 0o700 });
	const path = join(locks, name);
	const file = await open(path, 'a', 0o600);
	const deadline = Date.now() + timeoutMs;
	try {
		while (libc.symbols.flock(file.fd, LOCK_EX | LOCK_NB) !== 0) {
			const errno = lastErrno();
			if (errno !== EWOULDBLOCK) throw new Error(`could not lock ${path} (error ${errno})`);
			if (Date.now() > deadline) throw new Error(`timed out waiting for lock at ${path}`);
			await Bun.sleep(25);
		}
	} catch (error) {
		await file.close();
		throw error;
	}
	let released = false;
	return {
		release: async () => {
			if (released) return;
			released = true;
			await file.close();
		},
	};
}
