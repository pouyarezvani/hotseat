import { realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Finds the menu bar app. It sits beside the installed binary in a normal
 * install, and inside the checkout when run from source.
 */
export async function findApp(): Promise<string | null> {
	// The running binary is often reached through a symlink on PATH, so the
	// checkout it belongs to is found from its real location, not the link.
	const real = await realpath(process.execPath).catch(() => process.execPath);
	const near = dirname(real);
	const candidates = [
		...(process.env.HOTSEAT_APP ? [process.env.HOTSEAT_APP] : []),
		join(homedir(), 'Applications', 'Hotseat.app'),
		'/Applications/Hotseat.app',
		resolve(near, '..', 'macos', 'build', 'Hotseat.app'),
		resolve(near, 'Hotseat.app'),
	];
	for (const candidate of candidates) {
		if (await Bun.file(join(candidate, 'Contents', 'MacOS', 'Hotseat')).exists()) return candidate;
	}
	return null;
}

const BUNDLE_ID = 'dev.hotseat.menubar';

/** The process id of the running menu bar app, found by its bundle id, or nothing. */
async function runningPid(): Promise<number | undefined> {
	const proc = Bun.spawn(['lsappinfo', 'info', '-only', 'pid', '-app', BUNDLE_ID], {
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	const pid = /\bpid = (\d+)/.exec(text)?.[1];
	return pid ? Number.parseInt(pid, 10) : undefined;
}

export async function isRunning(): Promise<boolean> {
	return (await runningPid()) !== undefined;
}

export async function stopMenuBar(): Promise<void> {
	const pid = await runningPid();
	if (pid === undefined) return;
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		// It has already gone.
	}
}

export async function startMenuBar(app: string): Promise<void> {
	const proc = Bun.spawn(['open', '-a', app], { stdout: 'ignore', stderr: 'pipe' });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(stderr.trim() || `could not open ${app}`);
}

/** The launch agent earlier versions wrote loose into ~/Library/LaunchAgents. */
const LEGACY_AGENT_LABEL = 'dev.hotseat.menubar';

function legacyAgentPath(): string {
	return join(homedir(), 'Library', 'LaunchAgents', `${LEGACY_AGENT_LABEL}.plist`);
}

/** Unloads and deletes the loose launch agent, and says whether there was one. */
async function removeLegacyAgent(): Promise<boolean> {
	const path = legacyAgentPath();
	if (!(await Bun.file(path).exists())) return false;
	await Bun.spawn(
		['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/${LEGACY_AGENT_LABEL}`],
		{
			stdout: 'ignore',
			stderr: 'ignore',
		},
	).exited;
	await rm(path, { force: true });
	return true;
}

/** How long the app gets to answer a login-item request. */
const ANSWER_WITHIN_MS = 20_000;

interface AskOptions {
	answerWithinMs?: number;
}

/**
 * Has the app turn the launch agent inside its bundle on or off, or report it,
 * and returns the state it reports: enabled, requires approval, off or not found.
 * An app built before it carried that agent is refused, and an app that does
 * not answer in time is stopped.
 */
async function askApp(
	app: string,
	request: 'on' | 'off' | 'status',
	options: AskOptions,
): Promise<string> {
	const proc = Bun.spawn([join(app, 'Contents', 'MacOS', 'Hotseat'), '--login-item', request], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gaveUp = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), options.answerWithinMs ?? ANSWER_WITHIN_MS);
	});
	try {
		const answer = await Promise.race([
			Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]),
			gaveUp,
		]);
		if (answer === null) {
			proc.kill('SIGKILL');
			throw new Error('the menu bar app did not answer - rebuild it with: bash macos/build.sh');
		}
		const [out, err, code] = answer;
		if (code !== 0) {
			throw new Error(err.trim() || `the menu bar app could not change its login item (${code})`);
		}
		return out.trim();
	} finally {
		clearTimeout(timer);
	}
}

async function assertCurrent(app: string): Promise<void> {
	const agent = join(app, 'Contents', 'Library', 'LaunchAgents', 'dev.hotseat.login.plist');
	if (!(await Bun.file(agent).exists())) {
		throw new Error(
			'this Hotseat.app is too old to start at login - rebuild it with: bash macos/build.sh',
		);
	}
}

/**
 * Starts the app at every login. A loose launch agent left by an earlier
 * version is removed only once the app has answered, so a failed attempt
 * leaves Hotseat starting at login as before.
 */
export async function installLoginItem(app: string, options: AskOptions = {}): Promise<string> {
	await assertCurrent(app);
	const state = await askApp(app, 'on', options);
	await removeLegacyAgent();
	return state;
}

/**
 * Stops the app starting at login, and says whether it had been set to. A
 * loose launch agent left by an earlier version is removed only once the app
 * has answered.
 */
export async function removeLoginItem(app: string, options: AskOptions = {}): Promise<boolean> {
	await assertCurrent(app);
	const before = await askApp(app, 'status', options);
	if (before !== 'off') await askApp(app, 'off', options);
	const legacy = await removeLegacyAgent();
	return legacy || before !== 'off';
}

export async function loginItemStatus(app: string, options: AskOptions = {}): Promise<string> {
	await assertCurrent(app);
	const status = await askApp(app, 'status', options);
	if (status === 'off' && (await Bun.file(legacyAgentPath()).exists())) {
		return 'enabled by an older launch agent - run hotseat menubar install to update it';
	}
	return status;
}
