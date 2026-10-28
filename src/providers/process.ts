import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonLoose, writeJsonAtomic } from '../core/fs.ts';
import type { RunningProcess } from '../core/types.ts';

export async function listProcesses(pattern: RegExp): Promise<RunningProcess[]> {
	const proc = Bun.spawn(['ps', '-Ao', 'pid=,args='], { stdout: 'pipe', stderr: 'ignore' });
	const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0)
		throw new Error(`could not list running processes (ps ended with status ${code})`);
	const found: RunningProcess[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const space = trimmed.indexOf(' ');
		if (space < 0) continue;
		const pid = Number.parseInt(trimmed.slice(0, space), 10);
		const command = trimmed.slice(space + 1);
		if (!Number.isFinite(pid) || pid === process.pid) continue;
		if (!pattern.test(command)) continue;
		found.push({ pid, command });
	}
	return found;
}

/** When a process started, as the system prints it; empty when it is not running. */
async function startedAt(pid: number): Promise<string> {
	const proc = Bun.spawn(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return text.trim().replace(/\s+/g, ' ');
}

interface RunMark {
	pid: number;
	startedAt: string;
}

function runsDir(dir: string): string {
	return join(dir, 'hotseat-runs');
}

/**
 * Records in a session folder an agent hotseat started there, one record per
 * run, so two terminals running as one account are told apart. The process is
 * named with when it started, so a later process given the same number is
 * never taken for it.
 */
export async function markRunning(dir: string, pid: number): Promise<void> {
	const started = await startedAt(pid);
	if (started.length === 0) throw new Error(`could not record process ${pid} as running`);
	await writeJsonAtomic(join(runsDir(dir), `${pid}.json`), {
		pid,
		startedAt: started,
	} satisfies RunMark);
}

export async function clearRunMark(dir: string, pid: number): Promise<void> {
	await rm(join(runsDir(dir), `${pid}.json`), { force: true });
}

/**
 * Whether any agent hotseat recorded in a session folder is still running. A
 * recorded process that is alive but whose start cannot be read counts as
 * running: a session is never taken for idle on a guess.
 */
export async function markedRunning(dir: string): Promise<boolean> {
	const names = await readdir(runsDir(dir)).catch(() => [] as string[]);
	for (const name of names) {
		const mark = await readJsonLoose<RunMark>(join(runsDir(dir), name));
		if (typeof mark?.pid !== 'number' || typeof mark.startedAt !== 'string') continue;
		if (!alive(mark.pid)) continue;
		const now = await startedAt(mark.pid);
		if (now.length === 0 || now === mark.startedAt) return true;
	}
	return false;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === 'EPERM';
	}
}
