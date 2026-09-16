import type { RunningProcess } from '../core/types.ts';

export async function listProcesses(pattern: RegExp): Promise<RunningProcess[]> {
	const proc = Bun.spawn(['ps', '-Ao', 'pid=,args='], { stdout: 'pipe', stderr: 'ignore' });
	const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) return [];
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
