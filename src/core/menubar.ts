import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'dev.hotseat.menubar';

function launchAgentPath(): string {
	return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

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

export function isRunning(): Promise<boolean> {
	return Bun.spawn(['pgrep', '-f', 'Hotseat.app/Contents/MacOS/Hotseat'], {
		stdout: 'ignore',
		stderr: 'ignore',
	}).exited.then((code) => code === 0);
}

export async function stopMenuBar(): Promise<void> {
	await Bun.spawn(['pkill', '-f', 'Hotseat.app/Contents/MacOS/Hotseat'], {
		stdout: 'ignore',
		stderr: 'ignore',
	}).exited;
}

export async function startMenuBar(app: string): Promise<void> {
	const proc = Bun.spawn(['open', '-a', app], { stdout: 'ignore', stderr: 'pipe' });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(stderr.trim() || `could not open ${app}`);
}

/**
 * The launch agent points at the executable rather than the bundle, because a
 * bundle launched through `open` is not a child of launchd and so cannot be
 * kept running by it.
 */
export function launchAgentPlist(app: string, binary: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${join(app, 'Contents', 'MacOS', 'Hotseat')}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOTSEAT_BIN</key><string>${binary}</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><false/>
	<key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

export async function installLoginItem(app: string, binary: string): Promise<string> {
	const path = launchAgentPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, launchAgentPlist(app, binary), { mode: 0o644 });
	// Replace any previous registration rather than layering a second one.
	await Bun.spawn(
		['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`],
		{
			stdout: 'ignore',
			stderr: 'ignore',
		},
	).exited;
	const load = Bun.spawn(['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, path], {
		stdout: 'ignore',
		stderr: 'pipe',
	});
	const [stderr, code] = await Promise.all([new Response(load.stderr).text(), load.exited]);
	if (code !== 0) throw new Error(stderr.trim() || `launchctl refused the login item (${code})`);
	return path;
}

export async function removeLoginItem(): Promise<boolean> {
	const path = launchAgentPath();
	const existed = await Bun.file(path).exists();
	await Bun.spawn(
		['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`],
		{
			stdout: 'ignore',
			stderr: 'ignore',
		},
	).exited;
	await rm(path, { force: true });
	return existed;
}

export function loginItemInstalled(): Promise<boolean> {
	return Bun.file(launchAgentPath()).exists();
}
