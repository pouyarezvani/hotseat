import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCommand } from '../src/core/agent-command.ts';
import { loginCodexIsolated } from '../src/core/enroll.ts';
import { loginIsolated } from '../src/providers/claude/login.ts';

/** The PATH macOS gives an app, and everything an app starts. */
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

let root = '';
let agents = '';
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

async function script(path: string, body: string): Promise<void> {
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
}

/** A login shell that talks first, as a real one with a busy profile does, then reports its PATH. */
async function shellThatKnows(path: string): Promise<string> {
	const shell = join(root, 'shell');
	await script(
		shell,
		[
			`echo "$@" >> ${join(root, 'shell-calls')}`,
			'echo "Welcome back"',
			`PATH='${path}' /bin/sh -c "$2"`,
			'echo "PATH=/not/this/one"',
		].join('\n'),
	);
	return shell;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'hotseat-agent-'));
	agents = join(root, 'agents');
	await Bun.write(join(agents, '.keep'), '');
	process.env.PATH = GUI_PATH;
});

afterEach(async () => {
	process.env.PATH = saved.PATH;
	if (saved.SHELL === undefined) delete process.env.SHELL;
	else process.env.SHELL = saved.SHELL;
	await rm(root, { recursive: true, force: true });
});

describe('finding an agent command from the menu bar', () => {
	test("one only the user's shell knows about is found there, and runs with that PATH", async () => {
		await script(join(agents, 'fakeagent'), 'exit 0');
		process.env.SHELL = await shellThatKnows(`${agents}:/usr/bin:/bin`);
		const found = await agentCommand('fakeagent');
		expect(found.executable).toBe(join(agents, 'fakeagent'));
		expect(found.env.PATH?.split(':')).toEqual([agents, '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
	});

	test('one already on PATH is used as it is, without starting a shell', async () => {
		await script(join(agents, 'fakeagent'), 'exit 0');
		process.env.PATH = `${agents}:${GUI_PATH}`;
		process.env.SHELL = await shellThatKnows(agents);
		const found = await agentCommand('fakeagent');
		expect(found.executable).toBe(join(agents, 'fakeagent'));
		expect(found.env.PATH).toBe(`${agents}:${GUI_PATH}`);
		expect(await Bun.file(join(root, 'shell-calls')).exists()).toBe(false);
	});

	test('one found nowhere is named, with what to do about it', async () => {
		process.env.SHELL = await shellThatKnows('/usr/bin:/bin');
		await expect(agentCommand('fakeagent')).rejects.toThrow(
			'could not find the fakeagent command - install it, or make sure your shell puts it on PATH',
		);
	});

	test('a shell that never answers is given up on', async () => {
		const shell = join(root, 'shell');
		await script(shell, 'sleep 30');
		process.env.SHELL = shell;
		const started = Date.now();
		await expect(agentCommand('fakeagent', { shellTimeoutMs: 300 })).rejects.toThrow(
			'could not find the fakeagent command',
		);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});

/** Whether a process id still names a running process. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Waits a bounded time for every process to be gone, and says whether they all went. */
async function allGone(pids: number[]): Promise<boolean> {
	for (let tries = 0; tries < 40; tries += 1) {
		if (pids.every((pid) => !alive(pid))) return true;
		await Bun.sleep(50);
	}
	return false;
}

async function pidIn(file: string): Promise<number> {
	for (let tries = 0; tries < 100; tries += 1) {
		const text = await Bun.file(file)
			.text()
			.catch(() => '');
		if (text.trim().length > 0) return Number.parseInt(text, 10);
		await Bun.sleep(50);
	}
	throw new Error(`nothing was written to ${file}`);
}

describe('a shell that does not behave', () => {
	test('one that ignores being asked to stop is still ended, with what it started', async () => {
		const shell = join(root, 'shell');
		await script(
			shell,
			[
				"trap '' TERM",
				`echo $$ > ${join(root, 'shell.pid')}`,
				'sleep 30 &',
				`echo $! > ${join(root, 'child.pid')}`,
				'wait',
			].join('\n'),
		);
		process.env.SHELL = shell;
		await expect(agentCommand('fakeagent', { shellTimeoutMs: 300 })).rejects.toThrow(
			'could not find the fakeagent command',
		);
		const pids = [await pidIn(join(root, 'shell.pid')), await pidIn(join(root, 'child.pid'))];
		expect(await allGone(pids)).toBe(true);
	});

	test('its answer is taken as soon as it is given, though something it started holds on', async () => {
		await script(join(agents, 'fakeagent'), 'exit 0');
		const shell = join(root, 'shell');
		await script(
			shell,
			[
				'sleep 30 &',
				`echo $! > ${join(root, 'background.pid')}`,
				`PATH='${agents}:/usr/bin:/bin' /bin/sh -c "$2"`,
				'exit 0',
			].join('\n'),
		);
		process.env.SHELL = shell;
		const started = Date.now();
		const found = await agentCommand('fakeagent');
		expect(found.executable).toBe(join(agents, 'fakeagent'));
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(await allGone([await pidIn(join(root, 'background.pid'))])).toBe(true);
	});

	test('its answer is found after startup output that ends without a new line', async () => {
		await script(join(agents, 'fakeagent'), 'exit 0');
		const shell = join(root, 'shell');
		await script(
			shell,
			["printf 'Welcome '", `PATH='${agents}:/usr/bin:/bin' /bin/sh -c "$2"`].join('\n'),
		);
		process.env.SHELL = shell;
		expect((await agentCommand('fakeagent')).executable).toBe(join(agents, 'fakeagent'));
	});

	test("once the shell has gone, its group's number is never signalled again, since it may be someone else's now", async () => {
		const shell = join(root, 'shell');
		await script(
			shell,
			[
				`echo $$ > ${join(root, 'shell.pid')}`,
				`/usr/bin/python3 -c 'import os, time; os.setsid(); time.sleep(5)' &`,
				`echo $! > ${join(root, 'holder.pid')}`,
				'exit 0',
			].join('\n'),
		);
		process.env.SHELL = shell;
		const signalled: { pid: number; at: number }[] = [];
		const started = Date.now();
		const original = process.kill;
		process.kill = ((pid: number, signal?: string | number): true => {
			signalled.push({ pid, at: Date.now() - started });
			return original.call(process, pid, signal);
		}) as typeof process.kill;
		try {
			await expect(agentCommand('fakeagent', { shellTimeoutMs: 1_500 })).rejects.toThrow(
				'could not find the fakeagent command',
			);
		} finally {
			process.kill = original;
			const holder = await pidIn(join(root, 'holder.pid'));
			if (alive(holder)) original(holder, 'SIGKILL');
		}
		const group = -(await pidIn(join(root, 'shell.pid')));
		expect(signalled.filter((entry) => entry.pid === group && entry.at >= 1_000)).toEqual([]);
	});

	test('a sign-in stopped while the shell is still answering leaves nothing running', async () => {
		const shell = join(root, 'shell');
		await script(
			shell,
			[
				`echo $$ > ${join(root, 'shell.pid')}`,
				'sleep 30 &',
				`echo $! > ${join(root, 'child.pid')}`,
				'wait',
			].join('\n'),
		);
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, 'fixtures', 'discovering.ts')],
			{
				env: { ...process.env, SHELL: shell, PATH: GUI_PATH },
				stdout: 'ignore',
				stderr: 'ignore',
			},
		);
		const pids = [await pidIn(join(root, 'shell.pid')), await pidIn(join(root, 'child.pid'))];
		child.kill('SIGTERM');
		expect(await child.exited).toBe(143);
		expect(await allGone(pids)).toBe(true);
	});
});

describe('signing in from the menu bar', () => {
	test('reaches Claude Code where only the shell can see it', async () => {
		await script(
			join(agents, 'claude'),
			[
				`echo "$@" > ${join(root, 'claude-args')}`,
				`printf '{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1,"scopes":[]}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
			].join('\n'),
		);
		process.env.SHELL = await shellThatKnows(`${agents}:/usr/bin:/bin`);
		const credential = await loginIsolated('someone@example.com');
		expect(credential.claudeAiOauth).toMatchObject({ accessToken: 'a', refreshToken: 'r' });
		expect((await Bun.file(join(root, 'claude-args')).text()).trim()).toBe(
			'auth login --claudeai --email someone@example.com',
		);
	});

	test('reaches Codex where only the shell can see it', async () => {
		await script(
			join(agents, 'codex'),
			`printf '{"tokens":{"access_token":"a"}}' > "$CODEX_HOME/auth.json"`,
		);
		process.env.SHELL = await shellThatKnows(`${agents}:/usr/bin:/bin`);
		expect(await loginCodexIsolated()).toEqual({ tokens: { access_token: 'a' } });
	});
});
