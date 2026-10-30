import { join } from 'node:path';
import { ServiceError } from '../src/core/errors.ts';
import type {
	Credential,
	Identity,
	LocalReading,
	Provider,
	ProviderId,
	RunningProcess,
	SessionSupport,
	UsageSnapshot,
} from '../src/core/types.ts';

/** A credential is just a token here, plus when it was issued and when it expires when that matters. */
export function cred(token: string, issued = 0, expires = 0): Credential {
	return { token, ...(issued > 0 ? { issued } : {}), ...(expires > 0 ? { expires } : {}) };
}

function issuedOf(credential: Credential): number {
	return typeof credential.issued === 'number' ? credential.issued : 0;
}

export function tokenOf(credential: Credential): string {
	return String(credential.token ?? '');
}

/**
 * A service that lives in memory: an installed login, a reading per token, and
 * a count of every request, so a test can say exactly what a command did.
 */
export class FakeProvider implements Provider {
	readonly id: ProviderId;
	readonly displayName: string;
	liveSwap = true;
	installed: Credential | null = null;
	readonly identities = new Map<string, Identity>();
	readonly readings = new Map<string, () => UsageSnapshot>();
	readonly calls = { identify: 0, fetchUsage: 0, refresh: 0, write: 0 };
	/** Reads and refreshes per token, for tests that care which login was used. */
	readonly readsOf = new Map<string, number>();
	readonly refreshesOf = new Map<string, number>();
	identifyFails = false;
	/** How long the service takes to say whose a login is, so a test can act in between. */
	identifyDelayMs = 0;
	/** When set, every refresh rotates the token by appending this. */
	rotate = '';
	/**
	 * Like the real services: once a refresh rotates a token, the old one is
	 * refused, so presenting it again fails exactly as a spent token would.
	 */
	spends = false;
	/** How long the service takes to answer a refresh, so two can overlap. */
	refreshDelayMs = 0;
	/** How long the service takes to deliver a reading it has already taken. */
	fetchDelayMs = 0;
	running: RunningProcess[] = [];
	/** Where the fake agent keeps its everyday setup; a test points this somewhere. */
	home = '';
	seeded: string[] = [];
	/** Session folders a test says have an agent running in them. */
	readonly runningIn = new Set<string>();
	readonly forgotten: string[] = [];
	readonly recorded: Identity[] = [];
	/** What the fake agent's own config file says it last saw, if anything. */
	local: LocalReading | null = null;
	/** What fetchUsage throws for a token, when a test wants a specific failure. */
	readonly failures = new Map<string, Error>();
	/** When set, reading the installed login fails with this, as a locked or slow keychain does. */
	readFailure: Error | null = null;
	/** When set, looking for running agents fails with this. */
	scanFailure: Error | null = null;
	/** When set, installing a login fails with this, as a locked keychain does. */
	writeFailure: Error | null = null;
	/** Runs while the service works on a refresh, so a test can change things meanwhile. */
	duringRefresh: ((credential: Credential) => Promise<void>) | null = null;
	/** Runs just after a login is installed, so a test can stop the writer right there. */
	afterWrite: (() => void | Promise<void>) | null = null;
	/** Runs just after the installed login is read, so a test can change it behind the reader. */
	afterRead: (() => void | Promise<void>) | null = null;
	session: SessionSupport;

	constructor(id: ProviderId) {
		this.id = id;
		this.displayName = id === 'claude' ? 'Claude' : 'Codex';
		this.session = {
			homeVariable: `${id.toUpperCase()}_HOME`,
			sharedHome: () => this.home,
			sharedEntries: ['settings.json', 'skills'],
			defaultCommand: id,
			writeLogin: (dir, credential) =>
				Bun.write(join(dir, 'login.json'), JSON.stringify(credential)).then(() => undefined),
			readLogin: async (dir) => {
				const file = Bun.file(join(dir, 'login.json'));
				return (await file.exists()) ? ((await file.json()) as Credential) : null;
			},
			compareAge: (a, b) => issuedOf(a) - issuedOf(b),
			seed: async (dir) => {
				this.seeded.push(dir);
			},
			isRunning: async (dir) => this.runningIn.has(dir),
			forget: async (dir) => {
				this.forgotten.push(dir);
			},
		};
	}

	sharesToken(a: Credential, b: Credential): boolean {
		return tokenOf(a) !== '' && tokenOf(a) === tokenOf(b);
	}

	expiresAt(credential: Credential): number | undefined {
		return typeof credential.expires === 'number' ? credential.expires : undefined;
	}

	async recordIdentity(identity: Identity): Promise<void> {
		this.recorded.push(identity);
	}

	/** How long the agent's own reading takes to come back, so two passes can overlap. */
	localDelayMs = 0;

	async localReading(): Promise<LocalReading | null> {
		if (this.localDelayMs > 0) await Bun.sleep(this.localDelayMs);
		return this.local;
	}

	async readAgentCredential(): Promise<Credential | null> {
		if (this.readFailure) throw this.readFailure;
		const read = this.installed ? structuredClone(this.installed) : null;
		await this.afterRead?.();
		return read;
	}

	async writeAgentCredential(credential: Credential): Promise<void> {
		if (this.writeFailure) throw this.writeFailure;
		this.calls.write += 1;
		this.installed = structuredClone(credential);
		await this.afterWrite?.();
	}

	async identify(credential: Credential): Promise<Identity> {
		this.calls.identify += 1;
		if (this.identifyDelayMs > 0) await Bun.sleep(this.identifyDelayMs);
		if (this.identifyFails) throw new Error('fetch failed');
		const identity = this.identities.get(tokenOf(credential));
		if (!identity) throw new Error('profile request failed with 401');
		return identity;
	}

	async fetchUsage(credential: Credential): Promise<UsageSnapshot> {
		this.calls.fetchUsage += 1;
		this.readsOf.set(tokenOf(credential), (this.readsOf.get(tokenOf(credential)) ?? 0) + 1);
		const failure = this.failures.get(tokenOf(credential));
		if (failure) throw failure;
		const read = this.readings.get(tokenOf(credential));
		if (!read) throw new Error('usage request failed with 401');
		const snapshot = read();
		if (this.fetchDelayMs > 0) await Bun.sleep(this.fetchDelayMs);
		return snapshot;
	}

	/** When set, refreshing this token fails with this error. */
	readonly refreshFailures = new Map<string, Error>();

	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		this.calls.refresh += 1;
		this.refreshesOf.set(tokenOf(credential), (this.refreshesOf.get(tokenOf(credential)) ?? 0) + 1);
		if (this.refreshDelayMs > 0) await Bun.sleep(this.refreshDelayMs);
		await this.duringRefresh?.(credential);
		const failure = this.refreshFailures.get(tokenOf(credential));
		if (failure) throw failure;
		if (!this.rotate) return credential;
		const next = cred(tokenOf(credential) + this.rotate, issuedOf(credential) + 1, 0);
		if (this.spends) {
			this.refreshFailures.set(
				tokenOf(credential),
				new ServiceError('token refresh failed with 400: invalid_grant', 400),
			);
		}
		this.identities.set(tokenOf(next), this.identities.get(tokenOf(credential)) ?? { email: '?' });
		const reading = this.readings.get(tokenOf(credential));
		if (reading) this.readings.set(tokenOf(next), reading);
		return next;
	}

	async runningProcesses(): Promise<RunningProcess[]> {
		if (this.scanFailure) throw this.scanFailure;
		return this.running;
	}
}

export function fakeProviders(): { claude: FakeProvider; codex: FakeProvider } {
	return { claude: new FakeProvider('claude'), codex: new FakeProvider('codex') };
}
