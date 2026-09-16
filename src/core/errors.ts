/**
 * What a service said when a request failed, kept as data rather than words
 * so the collector can tell a login that is gone from a service that is busy.
 */
export class ServiceError extends Error {
	readonly status: number | undefined;
	readonly retryAfterMs: number | undefined;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = 'ServiceError';
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

/** A Retry-After header is seconds or an HTTP date; either becomes a wait from now. */
export function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
	if (header === null || header === undefined) return undefined;
	const value = header.trim();
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const at = Date.parse(value);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export type FailureKind = 'auth' | 'throttled' | 'unreachable' | 'service' | 'other';

/** Only an auth failure says anything about the login itself. */
export function classify(error: unknown): FailureKind {
	const status = error instanceof ServiceError ? error.status : undefined;
	const message = error instanceof Error ? error.message : String(error);
	if (status === 401 || status === 403 || /invalid_grant|revoked/i.test(message)) return 'auth';
	if (status === 429) return 'throttled';
	if (status !== undefined && status >= 500) return 'service';
	if (status === 400 && /refresh/i.test(message)) return 'auth';
	if (/\b401\b|\b403\b/.test(message)) return 'auth';
	if (/\b429\b/.test(message)) return 'throttled';
	if (/\b5\d\d\b/.test(message)) return 'service';
	if (
		/timed? ?out|abort|fetch failed|ENOTFOUND|ECONNREFUSED|network|certificate|CERT/i.test(message)
	) {
		return 'unreachable';
	}
	return 'other';
}
