import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../../core/fs.ts';
import type { SessionSupport } from '../../core/types.ts';
import {
	isolateAccountKeys,
	mergeAccountKeys,
	oauthOf,
	readKeychain,
	writeKeychain,
} from './keychain.ts';
import { keychainServiceFor } from './login.ts';

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
	const main = (await readJson<Record<string, unknown>>(mainConfigPath)) ?? {};
	const path = join(dir, '.claude.json');
	const existing = (await readJson<Record<string, unknown>>(path)) ?? {};
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
		return oauthOf(credential)?.expiresAt ?? 0;
	},
	seed(dir) {
		return seedClaudeConfig(dir, claudeConfigPath());
	},
};
