import { spawn } from 'node:child_process';

const START = '__hotseat_path_start__';
const END = '__hotseat_path_end__';

/** How long the user's shell gets to report its PATH. */
const SHELL_TIMEOUT_MS = 10_000;

export interface AgentCommand {
	executable: string;
	env: Record<string, string | undefined>;
}

/**
 * Finds an agent's command and the environment to run it with. A command on
 * this process's PATH is used as it is; otherwise the PATH the user's login
 * shell sets up is put in front of it, and the command is looked up there.
 */
export async function agentCommand(
	name: string,
	options: { shellTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AgentCommand> {
	const own = process.env.PATH ?? '';
	const direct = Bun.which(name, { PATH: own });
	if (direct) return { executable: direct, env: { ...process.env } };
	const fromShell = await shellPath(options.shellTimeoutMs ?? SHELL_TIMEOUT_MS, options.signal);
	const path = [...new Set([...fromShell.split(':'), ...own.split(':')])]
		.filter((entry) => entry.length > 0)
		.join(':');
	const executable = Bun.which(name, { PATH: path });
	if (!executable) {
		throw new Error(
			`could not find the ${name} command - install it, or make sure your shell puts it on PATH`,
		);
	}
	return { executable, env: { ...process.env, PATH: path } };
}

/**
 * Asks a login, interactive shell for its PATH, framed by two marks so any
 * output its startup files print around it is skipped. The answer is taken as
 * soon as the closing mark arrives. The shell runs in its own process group,
 * which is killed outright when the shell exits, or earlier once there is an
 * answer, the time runs out, or the caller gives up; after the shell exits its
 * group's number is never signalled again. No answer in time is an empty PATH.
 */
function shellPath(timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
	const shell = process.env.SHELL || '/bin/zsh';
	return new Promise((resolve) => {
		const child = spawn(shell, ['-ilc', `printf '%s%s%s' ${START} "$PATH" ${END}`], {
			detached: true,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		let text = '';
		let settled = false;
		let shellGone = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const killGroup = (): void => {
			if (shellGone || child.pid === undefined) return;
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// The group is already gone.
			}
		};
		const finish = (path: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', giveUp);
			killGroup();
			child.stdout?.destroy();
			child.unref();
			resolve(path);
		};
		const giveUp = (): void => finish('');
		timer = setTimeout(giveUp, timeoutMs);
		signal?.addEventListener('abort', giveUp, { once: true });
		if (signal?.aborted) giveUp();
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			text += chunk;
			const start = text.indexOf(START);
			if (start < 0) return;
			const end = text.indexOf(END, start + START.length);
			if (end >= 0) finish(text.slice(start + START.length, end));
		});
		child.on('exit', () => {
			killGroup();
			shellGone = true;
		});
		child.on('error', giveUp);
		child.on('close', giveUp);
	});
}
