import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonLoose, writeJsonAtomic } from '../../core/fs.ts';
import type { SessionSupport } from '../../core/types.ts';
import {
	deleteKeychain,
	isolateAccountKeys,
	mergeAccountKeys,
	oauthOf,
	readKeychain,
	writeKeychain,
} from './keychain.ts';
import { keychainServiceFor } from './login.ts';
import { claudeSessions } from './sessions.ts';

/** Claude Code's everyday folder, never the one a session is running in. */
export function claudeHome(): string {
	return join(homedir(), '.claude');
}

/** Claude Code's user-level config file, beside the folder rather than in it. */
export function claudeConfigPath(): string {
	return join(homedir(), '.claude.json');
}

/**
 * What a session's own config file needs before Claude Code will start
 * without walking through first-run questions: the onboarding flags, the
 * theme, and the user-level MCP servers, mirrored from the everyday file on
 * every start so a server added later reaches the session too. Anything the
 * session has written to the file itself is kept.
 */
export async function seedClaudeConfig(dir: string, mainConfigPath: string): Promise<void> {
	// Claude Code rewrites its file constantly; a torn read is an empty file, not a stop.
	const main = (await readJsonLoose<Record<string, unknown>>(mainConfigPath)) ?? {};
	const path = join(dir, '.claude.json');
	const existing = (await readJsonLoose<Record<string, unknown>>(path)) ?? {};
	const seeded: Record<string, unknown> = {
		...existing,
		hasCompletedOnboarding: true,
		theme: existing.theme ?? main.theme ?? 'dark',
	};
	if (typeof main.mcpServers === 'object' && main.mcpServers !== null) {
		seeded.mcpServers = main.mcpServers;
	}
	await writeJsonAtomic(path, seeded, 0o600);
}

/**
 * Rewrites the account Claude Code records as signed in, so what it shows
 * and what hotseat installed agree. Everything else in the file, and any key
 * of the account entry hotseat does not know, is kept.
 */
export async function updateOauthAccount(path: string, identity: Identity): Promise<void> {
	const config = (await readJsonLoose<Record<string, unknown>>(path)) ?? {};
	const current =
		typeof config.oauthAccount === 'object' && config.oauthAccount !== null
			? (config.oauthAccount as Record<string, unknown>)
			: {};
	config.oauthAccount = {
		...current,
		emailAddress: identity.email,
		...(identity.organizationId ? { organizationUuid: identity.organizationId } : {}),
		...(identity.accountId ? { accountUuid: identity.accountId } : {}),
		...(identity.organizationName ? { organizationName: identity.organizationName } : {}),
	};
	await writeJsonAtomic(path, config, 0o600);
}

export const claudeSession: SessionSupport = {
	homeVariable: 'CLAUDE_CONFIG_DIR',
	sharedHome: claudeHome,
	// The setup: settings, instructions, skills, commands, agents, hooks and
	// plugins. Not chat history, not the login, not anything Claude Code keeps
	// per install, which stay the session's own.
	sharedEntries: [
		'settings.json',
		'settings.local.json',
		'keybindings.json',
		'CLAUDE.md',
		'skills',
		'commands',
		'agents',
		'hooks',
		'plugins',
		'scripts',
	],
	defaultCommand: 'claude',
	async writeLogin(dir, credential) {
		// The connector logins on the everyday entry belong to the machine, so
		// the session gets them too, under the account's own tokens.
		const shared = await readKeychain().catch(() => null);
		await writeKeychain(mergeAccountKeys(shared, credential), keychainServiceFor(dir));
	},
	async readLogin(dir) {
		const found = await readKeychain(keychainServiceFor(dir)).catch(() => null);
		return found ? isolateAccountKeys(found) : null;
	},
	issuedAt(credential) {
		// The sign-in's own expiry marks its generation; the access token's
		// expiry only says which copy was refreshed last, which an old sign-in
		// can win while a newer one sits saved.
		const oauth = oauthOf(credential);
		return oauth?.refreshTokenExpiresAt ?? oauth?.expiresAt ?? 0;
	},
	seed(dir) {
		return seedClaudeConfig(dir, claudeConfigPath());
	},
	async isRunning(dir) {
		return (await claudeSessions(dir)).length > 0;
	},
	forget(dir) {
		return deleteKeychain(keychainServiceFor(dir));
	},
};
