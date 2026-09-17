import { join } from 'node:path';
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
	/** When set, every refresh rotates the token by appending this. */
	rotate = '';
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
			issuedAt: (credential) => (typeof credential.issued === 'number' ? credential.issued : 0),
			seed: async (dir) => {
				this.seeded.push(dir);
			},
			isRunning: async (dir) => this.runningIn.has(dir),
			forget: async (dir) => {
				this.forgotten.push(dir);
			},
		};
	}

	expiresAt(credential: Credential): number | undefined {
		return typeof credential.expires === 'number' ? credential.expires : undefined;
	}

	async recordIdentity(identity: Identity): Promise<void> {
		this.recorded.push(identity);
	}

	async localReading(): Promise<LocalReading | null> {
		return this.local;
	}

	async readAgentCredential(): Promise<Credential | null> {
		return this.installed ? structuredClone(this.installed) : null;
	}

	async writeAgentCredential(credential: Credential): Promise<void> {
		this.calls.write += 1;
		this.installed = structuredClone(credential);
	}

	async identify(credential: Credential): Promise<Identity> {
		this.calls.identify += 1;
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
		return read();
	}

	/** When set, refreshing this token fails with this error. */
	readonly refreshFailures = new Map<string, Error>();

	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		this.calls.refresh += 1;
		this.refreshesOf.set(tokenOf(credential), (this.refreshesOf.get(tokenOf(credential)) ?? 0) + 1);
		const failure = this.refreshFailures.get(tokenOf(credential));
		if (failure) throw failure;
		if (!this.rotate) return credential;
		const next = cred(tokenOf(credential) + this.rotate, 0, 0);
		this.identities.set(tokenOf(next), this.identities.get(tokenOf(credential)) ?? { email: '?' });
		const reading = this.readings.get(tokenOf(credential));
		if (reading) this.readings.set(tokenOf(next), reading);
		return next;
	}

	async runningProcesses(): Promise<RunningProcess[]> {
		return this.running;
	}
}

export function fakeProviders(): { claude: FakeProvider; codex: FakeProvider } {
	return { claude: new FakeProvider('claude'), codex: new FakeProvider('codex') };
}
