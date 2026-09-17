import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../../core/fs.ts';
import { cleanUpEvenIfInterrupted } from '../../core/interrupt.ts';
import type { Credential } from '../../core/types.ts';
import { deleteKeychain, isolateAccountKeys, KEYCHAIN_SERVICE, readKeychain } from './keychain.ts';

/**
 * Claude Code derives its Keychain item name from the raw config directory it
 * was given, hashed. Pointing a sign-in at a scratch directory therefore lands
 * its credential in a separate item, leaving the one in everyday use untouched.
 */
export function keychainServiceFor(configDir: string): string {
	const digest = createHash('sha256').update(configDir.normalize('NFC'), 'utf8').digest('hex');
	return `${KEYCHAIN_SERVICE}-${digest.slice(0, 8)}`;
}

/**
 * Signs in to Claude against a scratch config directory and keeps the resulting
 * credential. This is a full sign-in, so the account carries the same
 * permissions as one added through Claude Code itself: its profile, its
 * sessions, connectors and uploads. A setup token would carry inference only,
 * which is not enough to even read the account's own usage.
 */
/** The sign-in command: a subscription sign-in, with the address filled in when known. */
export function loginArgs(email?: string): string[] {
	return ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])];
}

export async function loginIsolated(email?: string): Promise<Credential> {
	const configDir = await mkdtemp(join(tmpdir(), 'hotseat-claude-'));
	const service = keychainServiceFor(configDir);
	let child: ReturnType<typeof Bun.spawn> | undefined;
	return cleanUpEvenIfInterrupted(
		async () => {
			child?.kill();
			await deleteKeychain(service).catch(() => undefined);
			await rm(configDir, { recursive: true, force: true });
		},
		async () => {
			child = Bun.spawn(['claude', ...loginArgs(email)], {
				env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
				// With no terminal, as when the menu bar starts this, the browser
				// flow still completes on its own; there is just nobody to paste a code.
				stdin: process.stdin.isTTY ? 'inherit' : 'ignore',
				stdout: 'inherit',
				stderr: 'inherit',
			});
			const code = await child.exited;
			if (code !== 0) throw new Error(`the Claude sign-in ended with status ${code}`);

			// The Keychain is where a sign-in lands on macOS; the file is the fallback
			// every other platform uses, and the one a Keychain failure falls back to.
			const credential =
				(await readKeychain(service).catch(() => null)) ??
				(await readJson<Credential>(join(configDir, '.credentials.json')));
			if (!credential) throw new Error('the sign-in finished but left no credential to save');
			return isolateAccountKeys(credential);
		},
	);
}
