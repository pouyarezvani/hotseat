import { homedir } from 'node:os';
import { join } from 'node:path';
import { ResetNotSent, ResetRefused, retryAfterMs, ServiceError } from '../../core/errors.ts';
import { readJson, writeJsonAtomic } from '../../core/fs.ts';
import type {
	Credential,
	Identity,
	LimitReset,
	Provider,
	ResetUse,
	RunningProcess,
	SessionSupport,
	UsageSnapshot,
	UsageWindow,
} from '../../core/types.ts';
import { listProcesses, markedRunning } from '../process.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const RESETS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/**
 * How long a list of reset credits is trusted while the usage answer reports
 * the same number of them. The list is a request of its own, spent only when
 * the count moves or the list is this old.
 */
export const RESET_LIST_MAX_AGE_MS = 6 * 60 * 60_000;
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ORIGINATOR = 'codex_cli_rs';
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** How close to its expiry an access token is renewed rather than used. */
const REFRESH_MARGIN_MS = 5 * 60_000;
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
	rate_limit_reset_credits?: { available_count?: number | null } | null;
}

interface ResetCredit {
	id?: string;
	reset_type?: string | null;
	status?: string | null;
	expires_at?: string | null;
	title?: string | null;
	description?: string | null;
}

interface ResetCreditsPayload {
	credits?: ResetCredit[] | null;
}

export function authPath(): string {
	const home = process.env.CODEX_HOME;
	return join(home && home.length > 0 ? home : join(homedir(), '.codex'), 'auth.json');
}

function lastRefresh(credential: Credential): number {
	const stamp =
		typeof credential.last_refresh === 'string' ? Date.parse(credential.last_refresh) : Number.NaN;
	return Number.isFinite(stamp) ? stamp : 0;
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
	compareAge(a, b) {
		return lastRefresh(a) - lastRefresh(b);
	},
	// Codex leaves no record of which home a running process uses, so a session
	// is running while the agent hotseat started in it is; nothing outside the
	// folder to forget.
	isRunning: markedRunning,
	forget: async () => undefined,
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
	const resetAt = typeof window.reset_at === 'number' ? window.reset_at * 1000 : undefined;
	const length =
		typeof window.limit_window_seconds === 'number' && window.limit_window_seconds > 0
			? window.limit_window_seconds * 1000
			: undefined;
	return {
		key,
		label,
		percent: window.used_percent,
		...(resetAt !== undefined ? { resetsAt: new Date(resetAt).toISOString() } : {}),
		...(resetAt !== undefined && length !== undefined
			? { startsAt: new Date(resetAt - length).toISOString() }
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

/** The credits still waiting to be used, each clearing every limit Codex reports. */
export function mapResetCredits(
	payload: ResetCreditsPayload,
	windows: UsageWindow[],
): LimitReset[] | undefined {
	if (!Array.isArray(payload?.credits)) return undefined;
	const resets: LimitReset[] = [];
	for (const credit of payload.credits) {
		if (!credit || typeof credit.id !== 'string' || credit.id.trim().length === 0) continue;
		if (credit.status !== 'available') continue;
		const at = credit.expires_at ? Date.parse(credit.expires_at) : Number.NaN;
		const every = credit.reset_type === 'codex_rate_limits';
		resets.push({
			id: credit.id,
			title: credit.title || 'Full reset',
			...(every ? { ...coverEvery(windows), clearsEvery: true as const } : { clears: [] }),
			...(Number.isFinite(at) ? { expiresAt: new Date(at).toISOString() } : {}),
			...(credit.description ? { detail: credit.description } : {}),
		});
	}
	return resets;
}

/** The names and keys of every limit the account reports, which a full reset clears. */
function coverEvery(windows: UsageWindow[]): Pick<LimitReset, 'clears' | 'windowKeys'> {
	return {
		clears: windows.map((window) => window.label),
		windowKeys: windows.map((window) => window.key),
	};
}

/**
 * Whether any of the limits Codex keeps but the board does not draw is in use,
 * and until when: the last of their resets, when every one of them says.
 */
function additionalInUse(
	payload: UsagePayload,
): Pick<UsageSnapshot, 'otherLimitsInUse' | 'otherLimitsInUseUntil'> {
	const used = (payload.additional_rate_limits ?? [])
		.flatMap((limit) => [limit?.rate_limit?.primary_window, limit?.rate_limit?.secondary_window])
		.filter((window) => typeof window?.used_percent === 'number' && window.used_percent > 0);
	if (used.length === 0) return {};
	const resets = used.map((window) => window?.reset_at);
	const every = resets.every((at): at is number => typeof at === 'number' && Number.isFinite(at));
	return {
		otherLimitsInUse: true,
		...(every ? { otherLimitsInUseUntil: new Date(Math.max(...resets) * 1000).toISOString() } : {}),
	};
}

/** The last list of credits, when it can stand for the count the usage answer just gave. */
function stillCurrent(
	previous: UsageSnapshot | undefined,
	count: number,
	now: number,
): { limitResets: LimitReset[]; limitResetsReadAt: string } | null {
	const kept = previous?.limitResets;
	const readAt = previous?.limitResetsReadAt ? Date.parse(previous.limitResetsReadAt) : Number.NaN;
	if (!kept || previous?.limitResetsStale) return null;
	if (kept.length !== count || !Number.isFinite(readAt)) return null;
	if (now - readAt >= RESET_LIST_MAX_AGE_MS) return null;
	const lapsed = kept.some((reset) => reset.expiresAt && Date.parse(reset.expiresAt) <= now);
	return lapsed
		? null
		: { limitResets: kept, limitResetsReadAt: previous?.limitResetsReadAt ?? '' };
}

function decodeClaims(token: string | undefined): Record<string, unknown> {
	const payload = token?.split('.')[1];
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
			...(payload?.email ? { confirmed: true } : {}),
			...(payload?.plan_type ? { plan: payload.plan_type } : {}),
			...(tokens.account_id ? { accountId: tokens.account_id } : {}),
		};
	}

	/**
	 * The usage answer says how many reset credits the account holds; the
	 * credits themselves are asked for only when that number moves or the last
	 * list has grown old. A list that cannot be read leaves the last one standing.
	 */
	async fetchUsage(credential: Credential, previous?: UsageSnapshot): Promise<UsageSnapshot> {
		const now = Date.now();
		const fetchedAt = new Date(now).toISOString();
		const payload = await this.requestUsage(credential);
		const snapshot: UsageSnapshot = {
			...mapUsage(payload, fetchedAt),
			...additionalInUse(payload),
		};
		const count = payload.rate_limit_reset_credits?.available_count;
		if (typeof count !== 'number' || !Number.isFinite(count)) return snapshot;
		if (count <= 0) return { ...snapshot, limitResets: [], limitResetsReadAt: fetchedAt };
		const kept = stillCurrent(previous, count, now);
		if (kept) {
			const limitResets = kept.limitResets.map((reset) =>
				reset.clearsEvery ? { ...reset, ...coverEvery(snapshot.windows) } : reset,
			);
			return { ...snapshot, limitResets, limitResetsReadAt: kept.limitResetsReadAt };
		}
		const listedAt = new Date().toISOString();
		const credits = await this.request<ResetCreditsPayload>(credential, RESETS_URL, 'reset credits')
			.then((answer) => {
				const listed = mapResetCredits(answer, snapshot.windows);
				return listed?.length === count ? listed : undefined;
			})
			.catch(() => null);
		if (credits) return { ...snapshot, limitResets: credits, limitResetsReadAt: listedAt };
		const last = previous?.limitResets;
		if (!last) return snapshot;
		return {
			...snapshot,
			limitResets: last.map((reset) =>
				reset.clearsEvery ? { ...reset, ...coverEvery(snapshot.windows) } : reset,
			),
			...(previous?.limitResetsReadAt ? { limitResetsReadAt: previous.limitResetsReadAt } : {}),
			limitResetsStale: true,
		};
	}

	/**
	 * Uses one reset credit, the way Codex does when asked: named by its id,
	 * with a fresh request id so the service redeems it once.
	 */
	async useReset(
		credential: Credential,
		resetId: string,
		requestId: string,
		stillWanted?: () => boolean,
	): Promise<ResetUse> {
		if (!tokensOf(credential)) throw new ResetNotSent('no Codex credential');
		if (resetId.trim().length === 0) throw new ResetNotSent('a reset credit needs its id');
		if (stillWanted && !stillWanted()) throw new ResetNotSent('the reset can no longer be used');
		try {
			await this.request<unknown>(credential, `${RESETS_URL}/consume`, 'reset', {
				credit_id: resetId,
				redeem_request_id: requestId,
			});
		} catch (error) {
			if (error instanceof ServiceError && error.status !== undefined) {
				throw new ResetRefused(error.message, error.status, error.retryAfterMs);
			}
			throw error;
		}
		return { used: true };
	}

	private requestUsage(credential: Credential): Promise<UsagePayload> {
		return this.request<UsagePayload>(credential, USAGE_URL, 'usage');
	}

	private async request<T>(
		credential: Credential,
		url: string,
		what: string,
		body?: unknown,
	): Promise<T> {
		const tokens = tokensOf(credential);
		if (!tokens) throw new Error('no Codex credential');
		const response = await fetch(url, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			...(body !== undefined
				? { method: 'POST', body: JSON.stringify(body), redirect: 'manual' as const }
				: {}),
			headers: {
				authorization: `Bearer ${tokens.access_token}`,
				...(tokens.account_id ? { 'chatgpt-account-id': tokens.account_id } : {}),
				originator: ORIGINATOR,
				accept: 'application/json',
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
		});
		if (!response.ok) {
			throw new ServiceError(
				`${what} request failed with ${response.status}`,
				response.status,
				retryAfterMs(response.headers.get('retry-after'), Date.now()),
			);
		}
		if (body === undefined) return (await response.json()) as T;
		// A request that changes something is taken as carried out only from an
		// empty answer or one in JSON; anything else, such as a sign-in page,
		// says nothing about it.
		const text = await response.text();
		if (response.status === 204 || text.length === 0) return null as T;
		if (!(response.headers.get('content-type') ?? '').includes('json')) {
			throw new Error(`the service answered the ${what} request with something other than JSON`);
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new Error(`the service answered the ${what} request with unreadable JSON`);
		}
	}

	expiresAt(credential: Credential): number | undefined {
		const exp = decodeClaims(tokensOf(credential)?.access_token).exp;
		return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
	}

	sharesToken(a: Credential, b: Credential): boolean {
		const token = tokensOf(a)?.refresh_token;
		return token !== undefined && token.length > 0 && token === tokensOf(b)?.refresh_token;
	}

	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		const tokens = tokensOf(credential);
		if (!tokens) return credential;
		const last = Date.parse((credential as CodexAuth).last_refresh ?? '');
		const expires = this.expiresAt(credential);
		const recent = Number.isFinite(last) && Date.now() - last < REFRESH_AFTER_MS;
		const valid = expires === undefined || expires > Date.now() + REFRESH_MARGIN_MS;
		if (recent && valid) return credential;
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
		if (!response.ok) {
			throw new ServiceError(`token refresh failed with ${response.status}`, response.status);
		}
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
