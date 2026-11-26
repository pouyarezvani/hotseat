import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ResetNotSent, ResetRefused, retryAfterMs, ServiceError } from '../../core/errors.ts';
import { readJsonLoose } from '../../core/fs.ts';
import type {
	Credential,
	Identity,
	LimitReset,
	LocalReading,
	Provider,
	ResetUse,
	RunningProcess,
	SignedOut,
	UsageSnapshot,
	UsageWindow,
} from '../../core/types.ts';
import { listProcesses } from '../process.ts';
import {
	accountUuidOf,
	isolateAccountKeys,
	mergeAccountKeys,
	oauthOf,
	readKeychain,
	signedOutOf,
	writeKeychain,
} from './keychain.ts';
import { claudeConfigPath, claudeSession, updateOauthAccount } from './session.ts';
import { claudeSessions } from './sessions.ts';

const API = 'https://api.anthropic.com';
const USAGE_URL = `${API}/api/oauth/usage`;
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * The service lists an account's free limit resets only to a client that
 * names itself as a recent Claude Code. hotseat names the version installed,
 * and this one when none can be found.
 */
const KNOWN_CLI_VERSION = '2.1.330';
const RESET_PROGRAM = 'cedar_ember';
/** Reasons the service gives for listing no resets that are about the asking, not the account. */
const ASKED_WRONG = new Set(['surface', 'cli_version']);

/** The shape Claude Code holds a reset's id to before it asks for one to be used. */
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The answers in which the service says it did not use the reset. */
const REFUSAL_RESULTS = new Set([
	'already_used',
	'not_limited',
	'cooldown',
	'ineligible',
	'unavailable',
]);

/** Why the service did not use a reset, by what it answered. */
const REFUSED: Record<string, string> = {
	already_used: 'it was already used',
	not_limited: 'it can only be used once a limit it clears is reached',
	cooldown: 'resets are cooling down after the last one',
	ineligible: 'this account cannot use it',
	unavailable: 'it is not available right now',
	not_next_grant: 'another reset has to be used first',
	unknown_grant: 'the service no longer lists it',
};

const BLOCKED: Record<string, string> = {
	cooldown: 'cooling down after the last one',
	blocked_five_hour: 'not while the 5h limit is full',
	blocked_seven_day: 'not while the weekly limit is full',
	blocked_opus: 'not while the Opus limit is full',
	blocked_sonnet: 'not while the Sonnet limit is full',
	blocked_other: 'not while another limit is full',
	cannot_clear: 'nothing for it to clear yet',
	needs_limit: 'only once a limit it clears is reached',
	unavailable: 'not available right now',
};

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

interface ResetGrant {
	id?: string;
	label?: string | null;
	resets_left?: number | null;
	ends_at?: string | null;
	clears?: string[] | null;
	paused?: boolean | null;
	usable_now?: boolean | null;
	unavailable_reason?: string | null;
	gives_back_weekly?: boolean | null;
	percent_used?: Record<string, number> | null;
}

interface ResetProgram {
	eligible?: boolean | null;
	ineligible_reason?: string | null;
	grants?: ResetGrant[] | null;
}

interface UsagePayload {
	five_hour?: UsageBucket | null;
	seven_day?: UsageBucket | null;
	limits?: LimitRow[] | null;
	cedar_ember?: ResetProgram | null;
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
	const limitResets = mapResets(payload.cedar_ember, windows);
	if (!limitResets) return { fetchedAt, windows };
	const unnamed = (payload.cedar_ember?.grants ?? []).some(
		(grant) => !grant || typeof grant.id !== 'string' || grant.id.trim().length === 0,
	);
	return {
		fetchedAt,
		windows,
		limitResets,
		limitResetsReadAt: fetchedAt,
		...(unnamed ? { limitResetsIncomplete: true as const } : {}),
	};
}

function isoOf(stamp: string | null | undefined): string | undefined {
	const at = stamp ? Date.parse(stamp) : Number.NaN;
	return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** Where a model-scoped limit's name stands as a word of its own in a sentence. */
function names(text: string, model: string): boolean {
	const word = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

interface Cleared {
	/** What the board calls them. */
	labels: string[];
	/** The windows they may be: one each when known, every candidate when not. */
	keys: string[];
	/** One of them matches no window the board draws, and may be in use. */
	unseen?: boolean;
	/** One of them matches no window the board draws, and the service reports it empty. */
	emptyUnseen?: boolean;
}

function clearedOf(found: UsageWindow[], fallback: string): Cleared {
	return found.length > 0
		? { labels: found.map((window) => window.label), keys: found.map((window) => window.key) }
		: { labels: [fallback], keys: [] };
}

/**
 * The model limit a reset's model-scoped key stands for. The service does not
 * say which model, so it is the one its own description names, else the only
 * one whose number matches what the service reports for the key, else the only
 * model limit there is. Anything less certain is called a model limit, never a
 * guess at which.
 */
function modelLimitOf(grant: ResetGrant, key: string, scoped: UsageWindow[]): Cleared {
	const named = scoped.filter((window) => names(grant.label ?? '', window.label));
	if (named.length === 1) return clearedOf(named, 'model limit');
	const used = grant.percent_used?.[key];
	const matched =
		typeof used === 'number'
			? scoped.filter((window) => Math.round(window.percent) === Math.round(used))
			: [];
	if (matched.length === 1) return clearedOf(matched, 'model limit');
	const [only] = scoped;
	const fits = only && (typeof used !== 'number' || Math.round(only.percent) === Math.round(used));
	if (scoped.length === 1 && fits) return clearedOf(scoped, 'model limit');
	return {
		labels: ['model limit'],
		keys: (typeof used === 'number' ? matched : scoped).map((window) => window.key),
	};
}

/** The limits a reset clears: the board's names for them, and the windows they may be. */
function clearedBy(grant: ResetGrant, windows: UsageWindow[]): Cleared {
	const own = (key: string, fallback: string): Cleared =>
		clearedOf(
			windows.filter((window) => window.key === key),
			fallback,
		);
	const scoped = windows.filter((window) => window.key.startsWith('weekly_scoped:'));
	const model = (name: string): Cleared =>
		clearedOf(
			scoped.filter((window) => window.label.toLowerCase().includes(name.toLowerCase())),
			name,
		);
	const labels: string[] = [];
	const keys: string[] = [];
	let unseen = false;
	let emptyUnseen = false;
	for (const key of grant.clears ?? []) {
		const part =
			key === 'five_hour'
				? own('five_hour', '5h')
				: key === 'seven_day'
					? own('seven_day', 'week')
					: key === 'seven_day_overage_included'
						? modelLimitOf(grant, key, scoped)
						: key === 'seven_day_opus'
							? model('Opus')
							: key === 'seven_day_sonnet'
								? model('Sonnet')
								: key === 'seven_day_cowork'
									? { labels: ['Cowork'], keys: [] }
									: { labels: [], keys: [] };
		labels.push(...part.labels);
		keys.push(...part.keys);
		const used = grant.percent_used?.[key];
		if (part.keys.length === 0) {
			if (typeof used === 'number' && used <= 0) emptyUnseen = true;
			else unseen = true;
		}
	}
	return { labels: [...new Set(labels)], keys: [...new Set(keys)], unseen, emptyUnseen };
}

function resetTitle(keys: string[], labels: string[]): string {
	if (keys.includes('seven_day')) return keys.includes('five_hour') ? 'Full reset' : 'Weekly reset';
	if (keys.length === 1 && keys[0] === 'five_hour') return 'Session reset';
	return labels.length > 0 ? `${labels.join(' + ')} reset` : 'Limit reset';
}

/**
 * The free limit resets the account holds. Nothing when the service said
 * nothing about them, or declined to because of how it was asked: either says
 * nothing about whether the account has any.
 */
export function mapResets(
	program: ResetProgram | null | undefined,
	windows: UsageWindow[],
): LimitReset[] | undefined {
	if (!program || typeof program !== 'object') return undefined;
	if (program.eligible !== true) {
		return ASKED_WRONG.has(program.ineligible_reason ?? '') || program.eligible == null
			? undefined
			: [];
	}
	if (!Array.isArray(program.grants)) return undefined;
	const resets: LimitReset[] = [];
	for (const grant of program.grants) {
		if (!grant || typeof grant.id !== 'string' || grant.id.trim().length === 0) continue;
		const left = typeof grant.resets_left === 'number' ? grant.resets_left : undefined;
		if (left !== undefined && left <= 0) continue;
		const keys = grant.clears ?? [];
		const { labels: clears, keys: windowKeys, unseen, emptyUnseen } = clearedBy(grant, windows);
		const expiresAt = isoOf(grant.ends_at);
		const blocked = grant.paused
			? 'paused'
			: grant.usable_now === false
				? (BLOCKED[grant.unavailable_reason ?? ''] ?? BLOCKED.unavailable)
				: undefined;
		resets.push({
			id: grant.id,
			title: resetTitle(keys, clears),
			clears,
			...(windowKeys.length > 0 ? { windowKeys } : {}),
			...(unseen ? { clearsUnseen: true as const } : {}),
			...(emptyUnseen ? { clearsEmptyUnseen: true as const } : {}),
			...(grant.gives_back_weekly && !keys.includes('seven_day')
				? { givesBack: windows.find((window) => window.key === 'seven_day')?.label ?? 'week' }
				: {}),
			...(expiresAt ? { expiresAt } : {}),
			...(left !== undefined && left > 1 ? { left } : {}),
			...(blocked ? { blocked } : {}),
			...(grant.label ? { detail: grant.label } : {}),
		});
	}
	return resets;
}

function compareVersions(a: string, b: string): number {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		const gap = (left[index] ?? 0) - (right[index] ?? 0);
		if (gap !== 0) return gap;
	}
	return 0;
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** The Claude Code version installed here, from where its installer keeps each version. */
export async function cliVersion(home: string = homedir()): Promise<string> {
	const linked = await realpath(join(home, '.local', 'bin', 'claude')).catch(() => null);
	if (linked && VERSION.test(basename(linked))) return basename(linked);
	const kept = await readdir(join(home, '.local', 'share', 'claude', 'versions')).catch(
		() => [] as string[],
	);
	const newest = kept
		.filter((name) => VERSION.test(name))
		.sort(compareVersions)
		.at(-1);
	return newest ?? KNOWN_CLI_VERSION;
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

/**
 * Claude Code keeps the reading behind its own usage banner in its config
 * file, refreshed as it works. For the account in use that is fresher than
 * anything hotseat could ask for, and costs no request.
 */
export function localReadingFrom(config: Record<string, unknown>): LocalReading | null {
	const cached = config.cachedUsageUtilization;
	if (typeof cached !== 'object' || cached === null) return null;
	const entry = cached as {
		fetchedAtMs?: unknown;
		accountUuid?: unknown;
		utilization?: { five_hour?: UsageBucket | null; seven_day?: UsageBucket | null } | null;
	};
	if (typeof entry.fetchedAtMs !== 'number' || !Number.isFinite(entry.fetchedAtMs)) return null;
	const windows = mapUsage(
		{
			five_hour: entry.utilization?.five_hour ?? null,
			seven_day: entry.utilization?.seven_day ?? null,
		},
		new Date(entry.fetchedAtMs).toISOString(),
	).windows;
	if (windows.length === 0) return null;
	return {
		...(typeof entry.accountUuid === 'string' ? { accountId: entry.accountUuid } : {}),
		fetchedAtMs: entry.fetchedAtMs,
		windows,
	};
}

export class ClaudeProvider implements Provider {
	readonly id = 'claude' as const;
	readonly displayName = 'Claude';
	/** Claude Code re-reads the credential per request, so a swap lands mid-session. */
	readonly liveSwap = true;
	readonly session = claudeSession;

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
		if (!response.ok) {
			throw new ServiceError(
				`profile lookup failed with ${response.status}`,
				response.status,
				retryAfterMs(response.headers.get('retry-after'), Date.now()),
			);
		}
		const body = (await response.json()) as {
			account?: { email_address?: string; email?: string; uuid?: string };
			organization?: { name?: string; uuid?: string };
		};
		const email = body.account?.email_address ?? body.account?.email;
		if (!email) throw new Error('profile response carried no email address');
		return {
			email,
			confirmed: true,
			...(oauth.subscriptionType ? { plan: oauth.subscriptionType } : {}),
			...(body.account?.uuid ? { accountId: body.account.uuid } : {}),
			...(body.organization?.uuid ? { organizationId: body.organization.uuid } : {}),
			...(body.organization?.name ? { organizationName: body.organization.name } : {}),
		};
	}

	sharesToken(a: Credential, b: Credential): boolean {
		const token = oauthOf(a)?.refreshToken;
		return token !== undefined && token.length > 0 && token === oauthOf(b)?.refreshToken;
	}

	expiresAt(credential: Credential): number | undefined {
		const expires = oauthOf(credential)?.expiresAt;
		return expires !== undefined && expires > 0 ? expires : undefined;
	}

	signedOut(credential: Credential): SignedOut | undefined {
		return signedOutOf(credential);
	}

	signInEndsAt(credential: Credential): number | undefined {
		return oauthOf(credential)?.refreshTokenExpiresAt;
	}

	accountOf(credential: Credential): string | undefined {
		return accountUuidOf(credential);
	}

	/** Claude Code shows who is signed in from its own config file, which a switch must keep true. */
	recordIdentity(identity: Identity): Promise<void> {
		return updateOauthAccount(claudeConfigPath(), identity);
	}

	async localReading(): Promise<LocalReading | null> {
		const config = await readJsonLoose<Record<string, unknown>>(claudeConfigPath());
		return config ? localReadingFrom(config) : null;
	}

	async fetchUsage(credential: Credential): Promise<UsageSnapshot> {
		const fetchedAt = new Date().toISOString();
		const oauth = oauthOf(credential);
		if (!oauth) return { fetchedAt, windows: [], error: 'no Claude credential' };
		const response = await fetch(`${USAGE_URL}?${RESET_PROGRAM}=1`, {
			headers: {
				...headers(oauth.accessToken),
				'user-agent': `claude-cli/${await cliVersion()} (external, cli)`,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new ServiceError(
				`usage request failed with ${response.status}`,
				response.status,
				retryAfterMs(response.headers.get('retry-after'), Date.now()),
			);
		}
		return mapUsage((await response.json()) as UsagePayload, fetchedAt);
	}

	/**
	 * Uses one of the account's resets, the way Claude Code does when asked:
	 * named by its id, with a fresh request id so the service acts on it once.
	 */
	async useReset(
		credential: Credential,
		resetId: string,
		requestId: string,
		stillWanted?: () => boolean,
	): Promise<ResetUse> {
		const oauth = oauthOf(credential);
		if (!oauth) throw new ResetNotSent('no Claude credential');
		if (!GRANT_ID.test(resetId)) throw new ResetNotSent(`"${resetId}" is not a Claude reset`);
		if (!REQUEST_ID.test(requestId)) {
			throw new ResetNotSent('the request id is not one Claude accepts');
		}
		const identity = await this.identify(credential).catch((error: unknown) => {
			throw new ResetNotSent(
				`could not ask which organization this login is in: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		if (!identity.organizationId) {
			throw new ResetNotSent('the service did not say which organization this login is in');
		}
		const organizationId = identity.organizationId;
		const version = await cliVersion();
		if (stillWanted && !stillWanted()) throw new ResetNotSent('the reset can no longer be used');
		const response = await fetch(`${API}/api/organizations/${organizationId}/reset_rate_limits`, {
			method: 'POST',
			redirect: 'manual',
			headers: {
				...headers(oauth.accessToken),
				'content-type': 'application/json',
				'user-agent': `claude-cli/${version} (external, cli)`,
			},
			body: JSON.stringify({ program: RESET_PROGRAM, grant_id: resetId, request_id: requestId }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new ResetRefused(
				`reset request failed with ${response.status}`,
				response.status,
				retryAfterMs(response.headers.get('retry-after'), Date.now()),
			);
		}
		const body = (await response.json()) as { result?: unknown; reason?: unknown } | null;
		const result = typeof body?.result === 'string' ? body.result : undefined;
		if (result === 'reset') return { used: true };
		if (result === undefined || !REFUSAL_RESULTS.has(result)) {
			throw new Error('the service answered in a way hotseat does not recognise');
		}
		const reason = typeof body?.reason === 'string' ? body.reason : '';
		return {
			used: false,
			refused: REFUSED[reason] ?? REFUSED[result] ?? REFUSED.unavailable ?? '',
		};
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
		if (!response.ok) {
			throw new ServiceError(
				`token refresh failed with ${response.status}`,
				response.status,
				retryAfterMs(response.headers.get('retry-after'), Date.now()),
			);
		}
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
