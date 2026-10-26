import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = join(import.meta.dir, 'fixtures', 'login-item.ts');

let root = '';
let app = '';
let home = '';
let bin = '';
let calls = '';

async function script(path: string, body: string): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, 0o755);
}

/** An app that keeps its login item in a file and records every request made of it. */
async function fakeApp(): Promise<void> {
	await mkdir(join(app, 'Contents', 'Library', 'LaunchAgents'), { recursive: true });
	await writeFile(
		join(app, 'Contents', 'Library', 'LaunchAgents', 'dev.hotseat.login.plist'),
		'<plist/>',
	);
	await script(
		join(app, 'Contents', 'MacOS', 'Hotseat'),
		[
			`echo "app $*" >> ${calls}`,
			`state=${join(root, 'login-item')}`,
			'case "$2" in',
			'  on) echo enabled > "$state" ;;',
			'  off) echo off > "$state" ;;',
			'esac',
			'cat "$state" 2>/dev/null || echo off',
		].join('\n'),
	);
}

async function run(
	step: string,
	within?: number,
): Promise<{ result: unknown; code: number; stderr: string }> {
	const child = Bun.spawn(
		[process.execPath, fixture, step, app, ...(within ? [String(within)] : [])],
		{
			env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [out, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { result: out.trim() ? JSON.parse(out.trim()) : undefined, code, stderr };
}

/** Leaves the loose launch agent an earlier version wrote, and returns its path. */
async function olderAgent(): Promise<string> {
	const legacy = join(home, 'Library', 'LaunchAgents', 'dev.hotseat.menubar.plist');
	await mkdir(join(legacy, '..'), { recursive: true });
	await writeFile(legacy, '<plist/>');
	return legacy;
}

async function recorded(): Promise<string[]> {
	const text = await Bun.file(calls)
		.text()
		.catch(() => '');
	return text.split('\n').filter((line) => line.length > 0);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'hotseat-login-item-'));
	app = join(root, 'Hotseat.app');
	home = join(root, 'home');
	bin = join(root, 'bin');
	calls = join(root, 'calls');
	await mkdir(home, { recursive: true });
	await script(join(bin, 'launchctl'), `echo "launchctl $*" >> ${calls}`);
	await script(
		join(bin, 'lsappinfo'),
		`echo "lsappinfo $*" >> ${calls}\ncat ${join(root, 'running-pid')} 2>/dev/null`,
	);
	await script(join(bin, 'pgrep'), `echo "pgrep $*" >> ${calls}\nexit 1`);
	await script(join(bin, 'pkill'), `echo "pkill $*" >> ${calls}`);
	await fakeApp();
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('starting the menu bar app at login', () => {
	test('is set up by the app itself, through the launch agent it carries', async () => {
		const { result, code } = await run('install');
		expect(code).toBe(0);
		expect(result).toBe('enabled');
		expect(await recorded()).toEqual(['app --login-item on']);
	});

	test('an older loose launch agent is unloaded and removed once the app has taken over, so it never starts a second copy', async () => {
		const legacy = await olderAgent();
		const { code } = await run('install');
		expect(code).toBe(0);
		expect(await Bun.file(legacy).exists()).toBe(false);
		const uid = process.getuid?.() ?? 501;
		expect(await recorded()).toEqual([
			'app --login-item on',
			`launchctl bootout gui/${uid}/dev.hotseat.menubar`,
		]);
	});

	test('an older loose launch agent is kept when the app refuses to take over, so Hotseat still starts at login', async () => {
		const legacy = await olderAgent();
		await script(
			join(app, 'Contents', 'MacOS', 'Hotseat'),
			'echo "Operation not permitted" >&2\nexit 1',
		);
		for (const step of ['install', 'remove']) {
			expect((await run(step)).code).not.toBe(0);
			expect(await Bun.file(legacy).exists()).toBe(true);
		}
		expect((await recorded()).filter((line) => line.startsWith('launchctl'))).toEqual([]);
	});

	test('an older loose launch agent is kept when the app never answers', async () => {
		const legacy = await olderAgent();
		await script(join(app, 'Contents', 'MacOS', 'Hotseat'), 'exec sleep 30');
		for (const step of ['install', 'remove']) {
			expect((await run(step, 300)).code).not.toBe(0);
			expect(await Bun.file(legacy).exists()).toBe(true);
		}
		expect((await recorded()).filter((line) => line.startsWith('launchctl'))).toEqual([]);
	});

	test('its status is whatever the app reports', async () => {
		expect((await run('status')).result).toBe('off');
		await run('install');
		expect((await run('status')).result).toBe('enabled');
	});

	test('turning it off asks the app, and says whether it had been on', async () => {
		await run('install');
		expect((await run('remove')).result).toBe(true);
		expect((await run('status')).result).toBe('off');
		expect((await run('remove')).result).toBe(false);
	});

	test('turning it off also clears an older loose launch agent, and counts it as having been on', async () => {
		const legacy = await olderAgent();
		expect((await run('remove')).result).toBe(true);
		expect(await Bun.file(legacy).exists()).toBe(false);
	});

	test('an app that refuses says why', async () => {
		await script(
			join(app, 'Contents', 'MacOS', 'Hotseat'),
			'echo "Operation not permitted" >&2\nexit 1',
		);
		const { code, stderr } = await run('install');
		expect(code).not.toBe(0);
		expect(stderr).toContain('Operation not permitted');
	});
});

describe('an app that cannot do this', () => {
	test('an older build is refused before anything is changed, and nothing is left waiting on it', async () => {
		await rm(join(app, 'Contents', 'Library'), { recursive: true, force: true });
		await script(join(app, 'Contents', 'MacOS', 'Hotseat'), `echo "app $*" >> ${calls}\nsleep 30`);
		const legacy = await olderAgent();
		for (const step of ['install', 'remove', 'status']) {
			const started = Date.now();
			const { code, stderr } = await run(step);
			expect(code).not.toBe(0);
			expect(stderr).toContain(
				'this Hotseat.app is too old to start at login - rebuild it with: bash macos/build.sh',
			);
			expect(Date.now() - started).toBeLessThan(5_000);
		}
		expect(await Bun.file(legacy).exists()).toBe(true);
		expect(await recorded()).toEqual([]);
	});

	test('an app that never answers is given up on, and stopped', async () => {
		await script(
			join(app, 'Contents', 'MacOS', 'Hotseat'),
			`echo $$ > ${join(root, 'app.pid')}\nexec sleep 30`,
		);
		const { code, stderr } = await run('install', 300);
		expect(code).not.toBe(0);
		expect(stderr).toContain('the menu bar app did not answer');
		const pid = Number.parseInt(await Bun.file(join(root, 'app.pid')).text(), 10);
		let alive = true;
		for (let tries = 0; tries < 40 && alive; tries += 1) {
			try {
				process.kill(pid, 0);
				await Bun.sleep(50);
			} catch {
				alive = false;
			}
		}
		expect(alive).toBe(false);
	});
});

describe('reporting an older login item', () => {
	test('one still started by the older loose launch agent is reported as such, not as off', async () => {
		await olderAgent();
		expect((await run('status')).result).toBe(
			'enabled by an older launch agent - run hotseat menubar install to update it',
		);
	});
});

describe('finding the running menu bar app', () => {
	test('it is found by its bundle id, and only that process is stopped', async () => {
		const decoy = join(root, 'Hotseat');
		await link(process.execPath, decoy);
		const unrelated = Bun.spawn([decoy, '-e', 'setTimeout(() => undefined, 30_000)']);
		const ours = Bun.spawn(['/bin/sleep', '30']);
		try {
			expect((await run('running')).result).toBe(false);
			await run('stop');
			await writeFile(join(root, 'running-pid'), `    pid = ${ours.pid} !cgsConnection\n`);
			expect((await run('running')).result).toBe(true);
			await run('stop');
			expect(await ours.exited).not.toBe(0);
			expect(unrelated.killed).toBe(false);
			expect(unrelated.exitCode).toBeNull();
			expect(
				(await recorded()).every(
					(line) => line === 'lsappinfo info -only pid -app dev.hotseat.menubar',
				),
			).toBe(true);
		} finally {
			unrelated.kill();
			ours.kill();
		}
	});
});
