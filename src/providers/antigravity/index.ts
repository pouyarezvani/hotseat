import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { retryAfterMs, ServiceError } from '../../core/errors.ts';
import { readJson, writeJsonAtomic } from '../../core/fs.ts';
import { hotseatHome } from '../../core/paths.ts';
import type {
	Credential,
	Identity,
	Provider,
	RunningProcess,
	SessionSupport,
	UsageSnapshot,
	UsageWindow,
} from '../../core/types.ts';
import { KEYCHAIN_TIMEOUT_MS, settleWithin } from '../claude/keychain.ts';
import { listProcesses } from '../process.ts';

const API = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/**
 * The service answers only a client that names itself as the Antigravity CLI,
 * and leaves limits out of its answer for a version it takes to be too old. So
 * hotseat names the version installed, and this one when none can be read.
 */
const KNOWN_VERSION = '1.5.9';
const VERSION_TIMEOUT_MS = 5_000;
const SECURITY = '/usr/bin/security';
const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';
const KEYCHAIN_PREFIX = 'go-keyring-base64:';
const NOT_FOUND_RC = 44;
const REQUEST_TIMEOUT_MS = 20_000;
/** How close to its expiry an access token is renewed rather than used. */
const RENEW_MARGIN_MS = 60_000;

interface AntigravityToken {
	access_token: string;
	refresh_token?: string;
	/** When the access token stops working, as the agent wrote it. */
	expiry?: string;
}

interface QuotaBucket {
	bucketId?: string;
	window?: string;
	resetTime?: string;
	remainingFraction?: number;
}

interface QuotaGroup {
	displayName?: string;
	buckets?: QuotaBucket[];
}

export interface QuotaSummary {
	groups?: QuotaGroup[];
}

interface Tier {
	name?: string;
}

interface CodeAssist {
	currentTier?: Tier;
	paidTier?: Tier;
}

/** The sign-in client the agent itself uses, as found in its own program. */
interface OauthClient {
	clientId: string;
	clientSecret: string;
}

/** What hotseat keeps so a renewal costs one request, and a search none. */
interface Store {
	client?: OauthClient & { size: number; mtimeMs: number };
	token?: { for: string; accessToken: string; expiresAt: number };
	version?: { value: string; size: number; mtimeMs: number };
}

async function loadStore(): Promise<Store> {
	return (await readJson<Store>(storePath()).catch(() => null)) ?? {};
}

/** Adds to what is kept, over whatever another pass kept meanwhile. */
async function keep(patch: Store): Promise<void> {
	await writeJsonAtomic(storePath(), { ...(await loadStore()), ...patch } satisfies Store);
}

function storePath(): string {
	return join(hotseatHome(), 'antigravity.json');
}

function tokenOf(credential: Credential): AntigravityToken | null {
	const token = credential.token as Partial<AntigravityToken> | undefined;
	if (!token || typeof token.access_token !== 'string' || token.access_token.length === 0) {
		return null;
	}
	return {
		access_token: token.access_token,
		...(typeof token.refresh_token === 'string' ? { refresh_token: token.refresh_token } : {}),
		...(typeof token.expiry === 'string' ? { expiry: token.expiry } : {}),
	};
}

function expiryOf(credential: Credential): number {
	const at = Date.parse(tokenOf(credential)?.expiry ?? '');
	return Number.isFinite(at) ? at : 0;
}

/** The agent stores its login as JSON, base64-encoded behind a fixed prefix. */
export function decodeKeychain(raw: string): Credential | null {
	const value = raw.trim();
	if (value.length === 0) return null;
	try {
		const text = value.startsWith(KEYCHAIN_PREFIX)
			? Buffer.from(value.slice(KEYCHAIN_PREFIX.length), 'base64').toString('utf8')
			: value;
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Credential)
			: null;
	} catch {
		return null;
	}
}

/** "Claude and GPT models" becomes "Claude and GPT": the word adds nothing beside a limit. */
function groupName(displayName: string | undefined): string {
	return (displayName ?? '').replace(/\s+models$/i, '').trim();
}

const WINDOW_ORDER = ['5h', 'weekly'];

function windowRank(window: string | undefined): number {
	const rank = WINDOW_ORDER.indexOf(window ?? '');
	return rank < 0 ? WINDOW_ORDER.length : rank;
}

/**
 * Turns the service's answer into limits. It says how much is left, so what is
 * used is the rest. A limit that comes with no number is left out rather than
 * shown as empty or full, since the answer did not say which.
 */
export function mapUsage(payload: QuotaSummary, fetchedAt: string): UsageSnapshot {
	const windows: UsageWindow[] = [];
	for (const group of payload.groups ?? []) {
		const name = groupName(group.displayName);
		const buckets = [...(group.buckets ?? [])].sort(
			(a, b) => windowRank(a.window) - windowRank(b.window),
		);
		for (const bucket of buckets) {
			if (typeof bucket.bucketId !== 'string' || typeof bucket.remainingFraction !== 'number') {
				continue;
			}
			const used = Math.min(100, Math.max(0, (1 - bucket.remainingFraction) * 100));
			const span = bucket.window === 'weekly' ? 'week' : (bucket.window ?? 'limit');
			windows.push({
				key: bucket.bucketId,
				label: name.length > 0 ? `${name} ${span}` : span,
				percent: Math.round(used * 10) / 10,
				...(bucket.window === 'weekly'
					? { span: 'week' as const }
					: bucket.window === '5h'
						? { span: '5h' as const }
						: {}),
				...(typeof bucket.resetTime === 'string' ? { resetsAt: bucket.resetTime } : {}),
			});
		}
	}
	return { fetchedAt, windows };
}

/** The plan a person pays for, when there is one; otherwise the one they are on. */
export function planOf(payload: CodeAssist): string | undefined {
	return payload.paidTier?.name ?? payload.currentTier?.name;
}

/** Every sign-in client and secret the agent's program carries. */
export function clientsIn(program: string): OauthClient[] {
	const ids = new Set(program.match(/\d{8,14}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com/g));
	const secrets = new Set(program.match(/GOCSPX-[A-Za-z0-9_-]{28}/g));
	const found: OauthClient[] = [];
	for (const clientId of ids) {
		for (const clientSecret of secrets) found.push({ clientId, clientSecret });
	}
	return found;
}

async function agentProgram(): Promise<{ path: string; size: number; mtimeMs: number } | null> {
	// A path given in the environment is the only place looked.
	const named = process.env.HOTSEAT_AGY;
	const candidates = named
		? [named]
		: [
				Bun.which('agy'),
				join(homedir(), '.local', 'bin', 'agy'),
				'/opt/homebrew/bin/agy',
				'/usr/local/bin/agy',
			];
	for (const path of candidates) {
		if (!path) continue;
		const info = await stat(path).catch(() => null);
		if (info?.isFile()) return { path, size: info.size, mtimeMs: info.mtimeMs };
	}
	return null;
}

/** The version of the agent installed here, asked of it once per build. */
async function agentVersion(): Promise<string> {
	const program = await agentProgram();
	if (!program) return KNOWN_VERSION;
	const kept = (await loadStore()).version;
	if (kept && kept.size === program.size && kept.mtimeMs === program.mtimeMs) return kept.value;
	try {
		const proc = Bun.spawn([program.path, '--version'], { stdout: 'pipe', stderr: 'ignore' });
		const [text] = await Promise.all([
			new Response(proc.stdout).text(),
			settleWithin(proc, VERSION_TIMEOUT_MS, 'agy'),
		]);
		const value = /^\s*(\d+\.\d+\.\d+)\b/.exec(text)?.[1];
		if (!value) return KNOWN_VERSION;
		await keep({ version: { value, size: program.size, mtimeMs: program.mtimeMs } });
		return value;
	} catch {
		return KNOWN_VERSION;
	}
}

function tokenKey(refreshToken: string): string {
	return createHash('sha256').update(refreshToken).digest('hex').slice(0, 16);
}

/**
 * Gets a new access token for a login whose own has run out. The agent renews
 * its token only while it runs, so on a Mac where it is closed the reading
 * would otherwise stop within the hour. The renewal is kept by hotseat and
 * never written back to the agent's login: the service hands out a new access
 * token without replacing the refresh token, so the agent's copy stays good.
 * The sign-in client is read from the agent's own program, and remembered
 * until that program changes.
 */
async function renew(refreshToken: string, now: number): Promise<Renewed> {
	const store = await loadStore();
	const program = await agentProgram();
	const remembered =
		store.client &&
		(!program || (store.client.size === program.size && store.client.mtimeMs === program.mtimeMs))
			? store.client
			: undefined;
	const tried = new Set<string>();
	const attempt = async (client: OauthClient): Promise<Renewed | null> => {
		tried.add(`${client.clientId}|${client.clientSecret}`);
		const response = await fetch(TOKEN_URL, {
			method: 'POST',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: client.clientId,
				client_secret: client.clientSecret,
			}).toString(),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			// Not this client: the program carries several, and only one issued this login.
			if (body.error === 'invalid_client' || body.error === 'unauthorized_client') return null;
			throw new ServiceError(
				`token refresh failed with ${response.status}${body.error ? ` ${body.error}` : ''}`,
				response.status,
			);
		}
		const body = (await response.json()) as { access_token?: string; expires_in?: number };
		if (typeof body.access_token !== 'string') {
			throw new Error('the token refresh sent an unreadable answer');
		}
		const expiresAt = now + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
		await keep({
			...(program ? { client: { ...client, size: program.size, mtimeMs: program.mtimeMs } } : {}),
			token: { for: tokenKey(refreshToken), accessToken: body.access_token, expiresAt },
		});
		return { accessToken: body.access_token, expiresAt };
	};
	if (remembered) {
		const token = await attempt(remembered);
		if (token) return token;
	}
	if (program) {
		const text = Buffer.from(await Bun.file(program.path).arrayBuffer()).toString('latin1');
		for (const client of clientsIn(text)) {
			if (tried.has(`${client.clientId}|${client.clientSecret}`)) continue;
			const token = await attempt(client);
			if (token) return token;
		}
	}
	throw new Error(
		'the Antigravity login has expired and could not be renewed from here - open Antigravity once',
	);
}

interface Renewed {
	accessToken: string;
	expiresAt: number;
}

/** An access token that works now: the login's own, the one kept, or a new one. */
async function accessToken(credential: Credential, now: number, forceNew = false): Promise<string> {
	const token = tokenOf(credential);
	if (!token) throw new Error('no Antigravity login');
	if (!forceNew && expiryOf(credential) - RENEW_MARGIN_MS > now) return token.access_token;
	if (!token.refresh_token) {
		if (forceNew) throw new ServiceError('the Antigravity login no longer works', 401);
		return token.access_token;
	}
	if (!forceNew) {
		const kept = (await loadStore()).token;
		if (
			kept &&
			kept.for === tokenKey(token.refresh_token) &&
			kept.expiresAt - RENEW_MARGIN_MS > now
		)
			return kept.accessToken;
	}
	return (await renew(token.refresh_token, now)).accessToken;
}

async function post(method: string, body: unknown, token: string): Promise<Response> {
	return fetch(`${API}:${method}`, {
		method: 'POST',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'user-agent': `antigravity/cli/${await agentVersion()}`,
		},
		body: JSON.stringify(body),
	});
}

/** Asks the service, renewing the access token once if it turns out to be spent. */
async function ask<T>(credential: Credential, method: string, body: unknown): Promise<T> {
	const now = Date.now();
	let response = await post(method, body, await accessToken(credential, now));
	if (response.status === 401) {
		response = await post(method, body, await accessToken(credential, now, true));
	}
	if (!response.ok) {
		throw new ServiceError(
			`${method} failed with ${response.status}`,
			response.status,
			retryAfterMs(response.headers.get('retry-after'), now),
		);
	}
	return (await response.json()) as T;
}

function quote(value: string): string {
	return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

/** The longest command `security -i` reads as one; past it the rest is run as a second command. */
export const KEYCHAIN_COMMAND_LIMIT = 4095;

/**
 * The one command that stores a login. A login too long to fit is refused
 * here, before anything is written: the tool would cut the command in two,
 * store a login that does not decode, and print the rest of it.
 */
export function keychainCommand(hex: string): string {
	const line = `add-generic-password -U -a ${quote(KEYCHAIN_ACCOUNT)} -s ${quote(KEYCHAIN_SERVICE)} -X ${hex}\n`;
	if (Buffer.byteLength(line, 'utf8') > KEYCHAIN_COMMAND_LIMIT) {
		throw new Error('the Antigravity login is too long to store safely - nothing was written');
	}
	return line;
}

/** The login as Antigravity stores it: JSON, base64-encoded behind a fixed prefix. */
export function encodeKeychain(credential: Credential): string {
	return `${KEYCHAIN_PREFIX}${Buffer.from(JSON.stringify(credential), 'utf8').toString('base64')}`;
}

/**
 * Antigravity keeps one login, in one Keychain item, with nothing to point it
 * at another. So there is no folder to run it from as a second account: every
 * terminal uses the login in use. What stays is telling two copies of a login
 * apart by age.
 */
export const antigravitySession: SessionSupport = {
	homeVariable: 'HOTSEAT_ANTIGRAVITY_HOME',
	sharedHome: () => join(homedir(), '.gemini'),
	sharedEntries: [],
	defaultCommand: 'agy',
	writeLogin: async () => {
		throw new Error(
			'Antigravity keeps a single login for every terminal, so it cannot run as a second account in one - switch to the account instead',
		);
	},
	readLogin: async () => null,
	compareAge(a, b) {
		return expiryOf(a) - expiryOf(b);
	},
	isRunning: async () => false,
	forget: async () => undefined,
};

export class AntigravityProvider implements Provider {
	readonly id = 'antigravity' as const;
	readonly displayName = 'Antigravity';
	/** Not known to pick up a new login while it runs, so a swap is taken to need a restart. */
	readonly liveSwap = false;
	readonly session = antigravitySession;

	async readAgentCredential(): Promise<Credential | null> {
		const proc = Bun.spawn(
			[SECURITY, 'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-w', '-s', KEYCHAIN_SERVICE],
			{ stdout: 'pipe', stderr: 'ignore' },
		);
		const [text, code] = await Promise.all([
			new Response(proc.stdout).text(),
			settleWithin(proc, KEYCHAIN_TIMEOUT_MS, 'the keychain'),
		]);
		if (code === NOT_FOUND_RC) return null;
		if (code !== 0) throw new Error(`keychain read failed with status ${code}`);
		return decodeKeychain(text);
	}

	/** Written through `security -i`, so the login never appears in a process list. */
	async writeAgentCredential(credential: Credential): Promise<void> {
		const hex = Buffer.from(encodeKeychain(credential), 'utf8').toString('hex');
		const line = keychainCommand(hex);
		const proc = Bun.spawn([SECURITY, '-i'], {
			stdin: new TextEncoder().encode(line),
			stdout: 'ignore',
			stderr: 'ignore',
		});
		const code = await settleWithin(proc, KEYCHAIN_TIMEOUT_MS, 'the keychain');
		// What the tool says is not repeated: it echoes the command it was
		// given, and the command is the login.
		if (code !== 0) throw new Error(`keychain write failed with status ${code}`);
	}

	async identify(credential: Credential): Promise<Identity> {
		const email = credential.id_token_email;
		if (typeof email !== 'string' || email.length === 0) {
			throw new Error('could not determine the Antigravity account email');
		}
		const plan = await ask<CodeAssist>(credential, 'loadCodeAssist', {
			metadata: { ideType: 'ANTIGRAVITY' },
		})
			.then(planOf)
			.catch(() => undefined);
		return { email, ...(plan ? { plan } : {}) };
	}

	async fetchUsage(credential: Credential): Promise<UsageSnapshot> {
		const fetchedAt = new Date().toISOString();
		return mapUsage(await ask<QuotaSummary>(credential, 'retrieveUserQuotaSummary', {}), fetchedAt);
	}

	expiresAt(credential: Credential): number | undefined {
		const at = expiryOf(credential);
		return at > 0 ? at : undefined;
	}

	/**
	 * Renews a login whose access token is close to its expiry. The service
	 * hands out a new access token and keeps honouring the token that renews
	 * it, so the login is the same one with a newer key.
	 */
	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		const token = tokenOf(credential);
		if (!token?.refresh_token) return credential;
		const now = Date.now();
		if (expiryOf(credential) - RENEW_MARGIN_MS > now) return credential;
		const renewed = await renew(token.refresh_token, now);
		const next = structuredClone(credential);
		next.token = {
			...(next.token as Record<string, unknown>),
			access_token: renewed.accessToken,
			expiry: new Date(renewed.expiresAt).toISOString(),
		};
		return next;
	}

	sharesToken(a: Credential, b: Credential): boolean {
		const token = tokenOf(a)?.refresh_token;
		return token !== undefined && token.length > 0 && token === tokenOf(b)?.refresh_token;
	}

	runningProcesses(): Promise<RunningProcess[]> {
		return listProcesses(/(^|\/)agy(\s|$)/);
	}
}
