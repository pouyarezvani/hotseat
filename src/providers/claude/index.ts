import type {
	Credential,
	Identity,
	Provider,
	RunningProcess,
	UsageSnapshot,
	UsageWindow,
} from '../../core/types.ts';
import { listProcesses } from '../process.ts';
import {
	isolateAccountKeys,
	mergeAccountKeys,
	oauthOf,
	readKeychain,
	writeKeychain,
} from './keychain.ts';
import { claudeSessions } from './sessions.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface UsageBucket {
	utilization?: number;
	resets_at?: string | null;
}

interface LimitRow {
	kind?: string;
	group?: string;
	percent?: number;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string | null } | null } | null;
}

interface UsagePayload {
	five_hour?: UsageBucket | null;
	seven_day?: UsageBucket | null;
	limits?: LimitRow[] | null;
}

function headers(accessToken: string): Record<string, string> {
	return {
		authorization: `Bearer ${accessToken}`,
		'anthropic-beta': OAUTH_BETA,
		accept: 'application/json',
	};
}

/**
 * Maps the account's windows in the order a person reads them: the session
 * window, the weekly total, then every model-scoped weekly limit the account
 * actually has. Model names come from the response, never a hardcoded list, so
 * a newly released model appears without a code change.
 */
export function mapUsage(payload: UsagePayload, fetchedAt: string): UsageSnapshot {
	const windows: UsageWindow[] = [];
	const fiveHour = payload.five_hour;
	if (fiveHour && typeof fiveHour.utilization === 'number') {
		windows.push({
			key: 'five_hour',
			label: '5h',
			percent: fiveHour.utilization,
			...(fiveHour.resets_at ? { resetsAt: fiveHour.resets_at } : {}),
		});
	}
	const sevenDay = payload.seven_day;
	if (sevenDay && typeof sevenDay.utilization === 'number') {
		windows.push({
			key: 'seven_day',
			label: 'week',
			percent: sevenDay.utilization,
			...(sevenDay.resets_at ? { resetsAt: sevenDay.resets_at } : {}),
		});
	}
	for (const row of payload.limits ?? []) {
		const name = row.scope?.model?.display_name;
		if (row.kind !== 'weekly_scoped' || !name || typeof row.percent !== 'number') continue;
		windows.push({
			key: `weekly_scoped:${name}`,
			label: name,
			percent: row.percent,
			...(row.resets_at ? { resetsAt: row.resets_at } : {}),
		});
	}
	return { fetchedAt, windows };
}

/**
 * A setup token is issued by `claude setup-token` and carries only inference
 * scope, so it never refreshes and has no matching refresh token. Wrapping it
 * in the same credential shape lets every other path treat it normally.
 */
export function credentialFromToken(token: string): Credential {
	const trimmed = token.trim();
	if (trimmed.length === 0) throw new Error('the token is empty');
	if (!trimmed.startsWith('sk-ant-')) {
		throw new Error('that does not look like a Claude token - they begin with sk-ant-');
	}
	return {
		claudeAiOauth: {
			accessToken: trimmed,
			refreshToken: '',
			expiresAt: 0,
			scopes: ['user:inference'],
		},
	};
}

export class ClaudeProvider implements Provider {
	readonly id = 'claude' as const;
	readonly displayName = 'Claude';
	/** Claude Code re-reads the credential per request, so a swap lands mid-session. */
	readonly liveSwap = true;

	async readAgentCredential(): Promise<Credential | null> {
		const live = await readKeychain();
		return live ? isolateAccountKeys(live) : null;
	}

	async writeAgentCredential(credential: Credential): Promise<void> {
		await writeKeychain(mergeAccountKeys(await readKeychain(), credential));
	}

	async identify(credential: Credential): Promise<Identity> {
		const oauth = oauthOf(credential);
		if (!oauth) throw new Error('credential carries no Claude OAuth tokens');
		const response = await fetch(PROFILE_URL, {
			headers: headers(oauth.accessToken),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`profile lookup failed with ${response.status}`);
		const body = (await response.json()) as {
			account?: { email_address?: string; email?: string };
			organization?: { name?: string };
		};
		const email = body.account?.email_address ?? body.account?.email;
		if (!email) throw new Error('profile response carried no email address');
		return { email, ...(oauth.subscriptionType ? { plan: oauth.subscriptionType } : {}) };
	}

	async fetchUsage(credential: Credential): Promise<UsageSnapshot> {
		const fetchedAt = new Date().toISOString();
		const oauth = oauthOf(credential);
		if (!oauth) return { fetchedAt, windows: [], error: 'no Claude credential' };
		const response = await fetch(USAGE_URL, {
			headers: headers(oauth.accessToken),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			return { fetchedAt, windows: [], error: `usage request failed with ${response.status}` };
		}
		return mapUsage((await response.json()) as UsagePayload, fetchedAt);
	}

	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		const oauth = oauthOf(credential);
		if (!oauth) return credential;
		// A setup token carries no refresh token and never expires on its own.
		if (oauth.refreshToken.length === 0) return credential;
		if (oauth.expiresAt > Date.now() + REFRESH_MARGIN_MS) return credential;
		const response = await fetch(TOKEN_URL, {
			method: 'POST',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				grant_type: 'refresh_token',
				refresh_token: oauth.refreshToken,
				client_id: CLIENT_ID,
			}),
		});
		if (!response.ok) throw new Error(`token refresh failed with ${response.status}`);
		const body = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};
		const next = structuredClone(credential);
		// Spread the stored object, not the narrowed view of it: the scopes and
		// anything else the sign-in granted must survive every refresh.
		const original =
			typeof credential.claudeAiOauth === 'object' && credential.claudeAiOauth !== null
				? (credential.claudeAiOauth as Record<string, unknown>)
				: {};
		next.claudeAiOauth = {
			...original,
			...oauth,
			accessToken: body.access_token,
			refreshToken: body.refresh_token ?? oauth.refreshToken,
			expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
		};
		return next;
	}

	/**
	 * Includes sessions running inside an editor extension, which share this
	 * machine's credential and therefore follow a switch, but do not appear in
	 * the process list as a `claude` command.
	 */
	async runningProcesses(): Promise<RunningProcess[]> {
		const sessions = await claudeSessions();
		if (sessions.length > 0) return sessions;
		return listProcesses(/(^|\/)claude(\s|$)/);
	}
}
