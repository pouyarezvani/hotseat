import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../../core/fs.ts';
import type {
	Credential,
	Identity,
	Provider,
	RunningProcess,
	SessionSupport,
	UsageSnapshot,
	UsageWindow,
} from '../../core/types.ts';
import { listProcesses } from '../process.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ORIGINATOR = 'codex_cli_rs';
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

interface CodexTokens {
	access_token: string;
	refresh_token: string;
	account_id?: string;
	id_token?: string;
}

interface CodexAuth {
	auth_mode?: string;
	OPENAI_API_KEY?: string | null;
	tokens?: CodexTokens;
	last_refresh?: string;
}

interface RateWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
}

interface RateLimit {
	primary_window?: RateWindow | null;
	secondary_window?: RateWindow | null;
}

interface UsagePayload {
	email?: string;
	plan_type?: string;
	account_id?: string;
	rate_limit?: RateLimit | null;
	additional_rate_limits?: { limit_name?: string; rate_limit?: RateLimit | null }[] | null;
}

export function authPath(): string {
	const home = process.env.CODEX_HOME;
	return join(home && home.length > 0 ? home : join(homedir(), '.codex'), 'auth.json');
}

export const codexSession: SessionSupport = {
	homeVariable: 'CODEX_HOME',
	sharedHome: () => join(homedir(), '.codex'),
	// The setup, not the login and not the transcripts, memories or state
	// databases, which Codex keeps per home.
	sharedEntries: [
		'config.toml',
		'AGENTS.md',
		'skills',
		'prompts',
		'rules',
		'hooks.json',
		'keybindings.json',
		'plugins',
	],
	defaultCommand: 'codex',
	writeLogin: (dir, credential) => writeJsonAtomic(join(dir, 'auth.json'), credential),
	readLogin: (dir) => readJson<Credential>(join(dir, 'auth.json')),
	issuedAt(credential) {
		const stamp =
			typeof credential.last_refresh === 'string'
				? Date.parse(credential.last_refresh)
				: Number.NaN;
		return Number.isFinite(stamp) ? stamp : 0;
	},
};

/** Turns a window's duration into the label a person uses for it. */
export function windowLabel(seconds: number | null | undefined): string {
	if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 'limit';
	const hours = seconds / 3600;
	if (hours >= 144) return 'week';
	if (hours >= 24) return `${Math.round(hours / 24)}d`;
	if (hours >= 1) return `${Math.round(hours)}h`;
	return `${Math.max(1, Math.round(seconds / 60))}m`;
}

function toWindow(
	key: string,
	label: string,
	window: RateWindow | null | undefined,
): UsageWindow | null {
	if (!window || typeof window.used_percent !== 'number') return null;
	return {
		key,
		label,
		percent: window.used_percent,
		...(typeof window.reset_at === 'number'
			? { resetsAt: new Date(window.reset_at * 1000).toISOString() }
			: {}),
	};
}

export function mapUsage(payload: UsagePayload, fetchedAt: string): UsageSnapshot {
	const windows: UsageWindow[] = [];
	const primary = payload.rate_limit?.primary_window;
	const secondary = payload.rate_limit?.secondary_window;
	const first = toWindow('primary', windowLabel(primary?.limit_window_seconds), primary);
	if (first) windows.push(first);
	const second = toWindow('secondary', windowLabel(secondary?.limit_window_seconds), secondary);
	if (second) windows.push(second);
	return { fetchedAt, windows };
}

function decodeClaims(idToken: string | undefined): Record<string, unknown> {
	const payload = idToken?.split('.')[1];
	if (!payload) return {};
	try {
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
}

function tokensOf(credential: Credential): CodexTokens | null {
	const tokens = (credential as CodexAuth).tokens;
	if (!tokens || typeof tokens.access_token !== 'string') return null;
	return tokens;
}

export class CodexProvider implements Provider {
	readonly id = 'codex' as const;
	readonly displayName = 'Codex';
	/** A running session is pinned to its account, so a swap needs a restart. */
	readonly liveSwap = false;
	readonly session = codexSession;

	readAgentCredential(): Promise<Credential | null> {
		return readJson<Credential>(authPath());
	}

	async writeAgentCredential(credential: Credential): Promise<void> {
		await writeJsonAtomic(authPath(), credential);
	}

	async identify(credential: Credential): Promise<Identity> {
		const tokens = tokensOf(credential);
		if (!tokens) throw new Error('credential carries no Codex tokens');
		const claims = decodeClaims(tokens.id_token);
		const claimedEmail = typeof claims.email === 'string' ? claims.email : undefined;
		const payload = await this.requestUsage(credential).catch(() => null);
		const email = payload?.email ?? claimedEmail;
		if (!email) throw new Error('could not determine the Codex account email');
		return {
			email,
			...(payload?.plan_type ? { plan: payload.plan_type } : {}),
			...(tokens.account_id ? { accountId: tokens.account_id } : {}),
		};
	}

	async fetchUsage(credential: Credential): Promise<UsageSnapshot> {
		const fetchedAt = new Date().toISOString();
		try {
			return mapUsage(await this.requestUsage(credential), fetchedAt);
		} catch (error) {
			return { fetchedAt, windows: [], error: (error as Error).message };
		}
	}

	private async requestUsage(credential: Credential): Promise<UsagePayload> {
		const tokens = tokensOf(credential);
		if (!tokens) throw new Error('no Codex credential');
		const response = await fetch(USAGE_URL, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: {
				authorization: `Bearer ${tokens.access_token}`,
				...(tokens.account_id ? { 'chatgpt-account-id': tokens.account_id } : {}),
				originator: ORIGINATOR,
				accept: 'application/json',
			},
		});
		if (!response.ok) throw new Error(`usage request failed with ${response.status}`);
		return (await response.json()) as UsagePayload;
	}

	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		const tokens = tokensOf(credential);
		if (!tokens) return credential;
		const last = Date.parse((credential as CodexAuth).last_refresh ?? '');
		if (Number.isFinite(last) && Date.now() - last < REFRESH_AFTER_MS) return credential;
		const response = await fetch(TOKEN_URL, {
			method: 'POST',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_id: CLIENT_ID,
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
				scope: 'openid profile email',
			}),
		});
		if (!response.ok) throw new Error(`token refresh failed with ${response.status}`);
		const body = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			id_token?: string;
		};
		const next = structuredClone(credential) as CodexAuth;
		next.tokens = {
			...tokens,
			access_token: body.access_token,
			refresh_token: body.refresh_token ?? tokens.refresh_token,
			...(body.id_token ? { id_token: body.id_token } : {}),
		};
		next.last_refresh = new Date().toISOString();
		return next as Credential;
	}

	runningProcesses(): Promise<RunningProcess[]> {
		return listProcesses(/(^|\/)codex(\s|$)/);
	}
}
