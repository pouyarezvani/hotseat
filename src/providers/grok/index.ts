import { homedir } from 'node:os';
import { join } from 'node:path';
import { retryAfterMs, ServiceError } from '../../core/errors.ts';
import { readJson, writeJsonAtomic } from '../../core/fs.ts';
import type {
	Credential,
	Identity,
	Provider,
	RunningProcess,
	SessionSupport,
	UsageSnapshot,
} from '../../core/types.ts';
import { listProcesses, markedRunning } from '../process.ts';

const API = 'https://cli-chat-proxy.grok.com/v1';
/**
 * The billing record as Grok's own usage view asks for it. Without the format
 * the service answers only for pay-as-you-go credits, which a plan's own
 * weekly limit is not part of.
 */
const BILLING_PATH = '/billing?format=credits';
const REQUEST_TIMEOUT_MS = 20_000;
/** How close to its expiry a login is renewed rather than used. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Where a login is filed when it does not say where it was made. */
const DEFAULT_SLOT = 'default';

/** A money amount as the service writes it. */
interface Amount {
	val?: number;
}

export interface Billing {
	config?: {
		/** The plan's own limit, when it has one: how long it runs and when it ends. */
		currentPeriod?: { type?: string; start?: string; end?: string };
		creditUsagePercent?: number;
		monthlyLimit?: Amount;
		used?: Amount;
		billingPeriodStart?: string;
		billingPeriodEnd?: string;
	};
}

interface User {
	subscriptionTier?: string;
}

export function grokHome(): string {
	const home = process.env.GROK_HOME;
	return home && home.length > 0 ? home : join(homedir(), '.grok');
}

/**
 * The login Grok keeps is a file of sign-ins keyed by where each was made.
 * The one in use is the one holding a key; hotseat keeps that entry whole.
 */
export function loginIn(file: unknown): Credential | null {
	if (typeof file !== 'object' || file === null || Array.isArray(file)) return null;
	for (const entry of Object.values(file as Record<string, unknown>)) {
		if (typeof entry !== 'object' || entry === null) continue;
		const key = (entry as Credential).key;
		if (typeof key === 'string' && key.length > 0) return entry as Credential;
	}
	return null;
}

function authPath(dir = grokHome()): string {
	return join(dir, 'auth.json');
}

/** Where in the file a login belongs: under where it was made, as Grok files it. */
function slotOf(credential: Credential): string {
	const { oidc_issuer: issuer, oidc_client_id: client } = credential;
	return typeof issuer === 'string' && typeof client === 'string'
		? `${issuer}::${client}`
		: DEFAULT_SLOT;
}

/** Puts a login in a Grok folder as the one in use, leaving anything else filed there. */
async function writeLoginTo(dir: string, credential: Credential): Promise<void> {
	const path = authPath(dir);
	const file = (await readJson<Record<string, unknown>>(path).catch(() => null)) ?? {};
	const kept = Object.fromEntries(
		Object.entries(file).filter(([, entry]) => loginIn({ entry }) === null),
	);
	await writeJsonAtomic(path, { ...kept, [slotOf(credential)]: credential });
}

function expiryOf(credential: Credential): number {
	const at = Date.parse(typeof credential.expires_at === 'string' ? credential.expires_at : '');
	return Number.isFinite(at) ? at : 0;
}

/**
 * Turns the billing record into a limit. The service gives a share used when
 * it has one, or an allowance and what was spent of it. An account it reports
 * no allowance for has no limit to draw, which is said rather than shown as a
 * bar at nothing.
 */
export function mapBilling(payload: Billing, fetchedAt: string): UsageSnapshot {
	const config = payload.config ?? {};
	const limit = config.monthlyLimit?.val;
	const used = config.used?.val;
	const share =
		typeof config.creditUsagePercent === 'number'
			? config.creditUsagePercent
			: typeof limit === 'number' && limit > 0 && typeof used === 'number'
				? (used / limit) * 100
				: undefined;
	if (share === undefined) {
		return { fetchedAt, windows: [], note: 'Grok reports no usage limit for this account' };
	}
	const weekly = config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY';
	const resetsAt = config.currentPeriod?.end ?? config.billingPeriodEnd;
	const startsAt = config.currentPeriod?.start ?? config.billingPeriodStart;
	return {
		fetchedAt,
		windows: [
			{
				key: weekly ? 'week' : 'month',
				label: weekly ? 'week' : 'month',
				span: weekly ? 'week' : 'month',
				percent: Math.round(Math.min(100, Math.max(0, share)) * 10) / 10,
				...(typeof resetsAt === 'string' ? { resetsAt } : {}),
				...(typeof resetsAt === 'string' && typeof startsAt === 'string' ? { startsAt } : {}),
			},
		],
	};
}

async function ask<T>(credential: Credential, path: string): Promise<T> {
	const key = credential.key;
	if (typeof key !== 'string' || key.length === 0) throw new Error('no Grok login');
	const now = Date.now();
	const response = await fetch(`${API}${path}`, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
	});
	if (!response.ok) {
		throw new ServiceError(
			`${path} failed with ${response.status}`,
			response.status,
			retryAfterMs(response.headers.get('retry-after'), now),
		);
	}
	return (await response.json()) as T;
}

export const grokSession: SessionSupport = {
	homeVariable: 'GROK_HOME',
	sharedHome: grokHome,
	// The setup, not the login and not the sessions or memory, which Grok
	// keeps per home.
	sharedEntries: ['config.toml', 'skills', 'hooks', 'rules', 'installed-plugins', 'bundled'],
	defaultCommand: 'grok',
	writeLogin: writeLoginTo,
	readLogin: async (dir) => loginIn(await readJson<unknown>(authPath(dir))),
	compareAge(a, b) {
		return expiryOf(a) - expiryOf(b);
	},
	// Grok leaves no record of which home a running process uses, so a session
	// is running while the agent hotseat started in it is.
	isRunning: markedRunning,
	forget: async () => undefined,
};

export class GrokProvider implements Provider {
	readonly id = 'grok' as const;
	readonly displayName = 'Grok';
	/** Not known to pick up a new login while it runs, so a swap is taken to need a restart. */
	readonly liveSwap = false;
	readonly session = grokSession;

	async readAgentCredential(): Promise<Credential | null> {
		return loginIn(await readJson<unknown>(authPath()));
	}

	writeAgentCredential(credential: Credential): Promise<void> {
		return writeLoginTo(grokHome(), credential);
	}

	async identify(credential: Credential): Promise<Identity> {
		const email = credential.email;
		if (typeof email !== 'string' || email.length === 0) {
			throw new Error('could not determine the Grok account email');
		}
		const plan = await ask<User>(credential, '/user?include=subscription')
			.then((user) => user.subscriptionTier)
			.catch(() => undefined);
		return { email, ...(plan ? { plan } : {}) };
	}

	async fetchUsage(credential: Credential): Promise<UsageSnapshot> {
		const fetchedAt = new Date().toISOString();
		return mapBilling(await ask<Billing>(credential, BILLING_PATH), fetchedAt);
	}

	expiresAt(credential: Credential): number | undefined {
		const at = expiryOf(credential);
		return at > 0 ? at : undefined;
	}

	sharesToken(a: Credential, b: Credential): boolean {
		const token = a.refresh_token;
		return typeof token === 'string' && token.length > 0 && token === b.refresh_token;
	}

	/**
	 * Renews a login close to its expiry. The service hands back a new token
	 * for renewing along with the new key and stops honouring the old one, so
	 * the result has to be saved wherever the login lives before it is used.
	 */
	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		const { refresh_token: refreshToken, oidc_client_id: client, oidc_issuer: issuer } = credential;
		if (typeof refreshToken !== 'string' || typeof client !== 'string') return credential;
		const expires = expiryOf(credential);
		if (expires > Date.now() + REFRESH_MARGIN_MS) return credential;
		const base = typeof issuer === 'string' && issuer.length > 0 ? issuer : 'https://auth.x.ai';
		const response = await fetch(`${base}/oauth2/token`, {
			method: 'POST',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: client,
			}).toString(),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			throw new ServiceError(
				`token refresh failed with ${response.status}${body.error ? ` ${body.error}` : ''}`,
				response.status,
			);
		}
		const body = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (typeof body.access_token !== 'string') {
			throw new Error('the token refresh sent an unreadable answer');
		}
		return {
			...structuredClone(credential),
			key: body.access_token,
			refresh_token: body.refresh_token ?? refreshToken,
			expires_at: new Date(
				Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 21_600) * 1000,
			).toISOString(),
		};
	}

	runningProcesses(): Promise<RunningProcess[]> {
		return listProcesses(/(^|\/)grok(\s|$)/);
	}
}
