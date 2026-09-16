import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../../core/fs.ts';
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
export async function loginIsolated(): Promise<Credential> {
	const configDir = await mkdtemp(join(tmpdir(), 'hotseat-claude-'));
	const service = keychainServiceFor(configDir);
	try {
		const child = Bun.spawn(['claude', 'auth', 'login'], {
			env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
			stdin: 'inherit',
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
	} finally {
		await deleteKeychain(service).catch(() => undefined);
		await rm(configDir, { recursive: true, force: true });
	}
}
