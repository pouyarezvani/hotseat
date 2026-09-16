import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../../core/fs.ts';
import type { RunningProcess } from '../../core/types.ts';

function configHome(): string {
	const override = process.env.CLAUDE_CONFIG_DIR;
	return override && override.length > 0 ? override : join(homedir(), '.claude');
}

interface SessionFile {
	pid?: number;
	entrypoint?: string;
	kind?: string;
	status?: string;
	cwd?: string;
}

interface IdeLock {
	pid?: number;
	ideName?: string;
	workspaceFolders?: string[];
}

function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Not ours to signal, but running all the same.
		return (error as { code?: string }).code === 'EPERM';
	}
}

/** How a session describes itself, in words rather than an internal name. */
function describeEntrypoint(entrypoint: string | undefined): string {
	switch (entrypoint) {
		case 'claude-vscode':
			return 'editor extension';
		case 'claude-desktop':
			return 'desktop app';
		case 'sdk-cli':
			return 'SDK';
		case 'mcp':
			return 'connector';
		default:
			return 'terminal';
	}
}

/**
 * Finds live Claude sessions from the files Claude Code itself keeps, rather
 * than by scanning the process list. That is what surfaces sessions running
 * inside an editor extension, which share this machine's credential but do not
 * look like a `claude` process.
 */
export async function claudeSessions(): Promise<RunningProcess[]> {
	const home = configHome();
	const found = new Map<number, string>();

	const sessionNames = await readdir(join(home, 'sessions')).catch(() => [] as string[]);
	for (const name of sessionNames) {
		if (!name.endsWith('.json')) continue;
		const session = await readJson<SessionFile>(join(home, 'sessions', name));
		const pid = session?.pid;
		if (typeof pid !== 'number' || !isAlive(pid)) continue;
		const where = session?.cwd ? ` in ${session.cwd.split('/').pop()}` : '';
		found.set(pid, `${describeEntrypoint(session?.entrypoint)}${where}`);
	}

	const lockNames = await readdir(join(home, 'ide')).catch(() => [] as string[]);
	for (const name of lockNames) {
		if (!name.endsWith('.lock')) continue;
		const lock = await readJson<IdeLock>(join(home, 'ide', name));
		const pid = lock?.pid;
		if (typeof pid !== 'number' || !isAlive(pid)) continue;
		const folder = lock?.workspaceFolders?.[0]?.split('/').pop();
		found.set(pid, `${lock?.ideName ?? 'editor'}${folder ? ` in ${folder}` : ''}`);
	}

	return [...found].map(([pid, command]) => ({ pid, command }));
}
