import { userInfo } from 'node:os';
import type { Credential } from '../../core/types.ts';

export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const OAUTH_KEY = 'claudeAiOauth';
const SECURITY = '/usr/bin/security';
const NOT_FOUND_RC = 44;
const STDIN_LINE_LIMIT = 4096 - 64;

/**
 * The Keychain entry is one shared item. These keys belong to the signed-in
 * account and travel with it; every other key belongs to this machine and the
 * live entry stays authoritative.
 */
export const ACCOUNT_KEYS = ['claudeAiOauth', 'trustedDeviceToken'] as const;

export interface ClaudeOauth {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	refreshTokenExpiresAt?: number;
	scopes?: string[];
	subscriptionType?: string;
	rateLimitTier?: string;
}

/** Mirrors the agent's own username resolution so both key the same item. */
export function keychainAccount(): string {
	const override = process.env.HOTSEAT_KEYCHAIN_ACCOUNT;
	if (override) return override;
	const fromEnv = process.env.USER;
	if (fromEnv) return fromEnv;
	try {
		return userInfo().username;
	} catch {
		return 'claude-code-user';
	}
}

/** How long a keychain call may take before it is treated as stuck. */
export const KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * Waits for a process to end, or ends it. A locked keychain can put up a
 * prompt and wait forever, which would leave every hotseat command hanging
 * with it; the menu bar app would sit busy until its own long timeout.
 */
export async function settleWithin(
	proc: { exited: Promise<number>; kill(): void },
	ms: number,
	what: string,
): Promise<number> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cutoff = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`${what} did not answer within ${ms / 1000}s (is it locked?)`));
		}, ms);
	});
	try {
		return await Promise.race([proc.exited, cutoff]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function readKeychain(service = KEYCHAIN_SERVICE): Promise<Credential | null> {
	const proc = Bun.spawn(
		[SECURITY, 'find-generic-password', '-a', keychainAccount(), '-w', '-s', service],
		{ stdout: 'pipe', stderr: 'ignore' },
	);
	const [text, code] = await Promise.all([
		new Response(proc.stdout).text(),
		settleWithin(proc, KEYCHAIN_TIMEOUT_MS, 'the keychain'),
	]);
	if (code === NOT_FOUND_RC) return null;
	if (code !== 0) throw new Error(`keychain read failed with status ${code}`);
	const raw = text.replace(/\n$/, '');
	if (raw.length === 0) return null;
	try {
		return JSON.parse(decodeIfHex(raw)) as Credential;
	} catch {
		return null;
	}
}

/** `security -w` hex-encodes any value that is not fully printable. */
function decodeIfHex(raw: string): string {
	if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return raw;
	return Buffer.from(raw, 'hex').toString('utf8');
}

function quote(value: string): string {
	return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Writes through `security -i` so the secret never appears in argv, where any
 * other process could read it from the process list. The argv form is the
 * fallback for a payload past the stdin line limit.
 */
export async function writeKeychain(
	credential: Credential,
	service = KEYCHAIN_SERVICE,
): Promise<void> {
	const hex = Buffer.from(JSON.stringify(credential), 'utf8').toString('hex');
	const account = keychainAccount();
	const line = `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hex}\n`;
	const useStdin = Buffer.byteLength(line, 'utf8') <= STDIN_LINE_LIMIT;
	const proc = useStdin
		? Bun.spawn([SECURITY, '-i'], { stdin: new TextEncoder().encode(line), stderr: 'pipe' })
		: Bun.spawn([SECURITY, 'add-generic-password', '-U', '-a', account, '-s', service, '-X', hex], {
				stderr: 'pipe',
			});
	const [stderr, code] = await Promise.all([
		new Response(proc.stderr).text(),
		settleWithin(proc, KEYCHAIN_TIMEOUT_MS, 'the keychain'),
	]);
	if (code !== 0) throw new Error(`keychain write failed: ${stderr.trim() || `status ${code}`}`);
}

export async function deleteKeychain(service = KEYCHAIN_SERVICE): Promise<void> {
	const proc = Bun.spawn(
		[SECURITY, 'delete-generic-password', '-a', keychainAccount(), '-s', service],
		{ stdout: 'ignore', stderr: 'ignore' },
	);
	const code = await settleWithin(proc, KEYCHAIN_TIMEOUT_MS, 'the keychain');
	if (code !== 0 && code !== NOT_FOUND_RC) {
		throw new Error(`keychain delete failed with status ${code}`);
	}
}

/** Carries the account's own keys onto the live entry, leaving machine keys alone. */
export function mergeAccountKeys(live: Credential | null, incoming: Credential): Credential {
	const merged: Credential = { ...(live ?? {}) };
	for (const key of ACCOUNT_KEYS) {
		if (key in incoming) merged[key] = incoming[key];
		else delete merged[key];
	}
	if (incoming.organizationUuid !== undefined) merged.organizationUuid = incoming.organizationUuid;
	return merged;
}

/** Keeps only what belongs to the account, for vault storage. */
export function isolateAccountKeys(credential: Credential): Credential {
	const isolated: Credential = {};
	for (const key of ACCOUNT_KEYS) {
		if (key in credential) isolated[key] = credential[key];
	}
	if (credential.organizationUuid !== undefined) {
		isolated.organizationUuid = credential.organizationUuid;
	}
	return isolated;
}

export function oauthOf(credential: Credential): ClaudeOauth | null {
	const value = credential[OAUTH_KEY];
	if (typeof value !== 'object' || value === null) return null;
	const oauth = value as Partial<ClaudeOauth>;
	if (typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return null;
	if (typeof oauth.refreshToken !== 'string') return null;
	return {
		accessToken: oauth.accessToken,
		refreshToken: oauth.refreshToken,
		expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0,
		...(typeof oauth.subscriptionType === 'string'
			? { subscriptionType: oauth.subscriptionType }
			: {}),
		...(typeof oauth.rateLimitTier === 'string' ? { rateLimitTier: oauth.rateLimitTier } : {}),
		...(typeof oauth.refreshTokenExpiresAt === 'number'
			? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt }
			: {}),
	};
}
