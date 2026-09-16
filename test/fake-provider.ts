import { join } from 'node:path';
import type {
	Credential,
	Identity,
	Provider,
	ProviderId,
	RunningProcess,
	SessionSupport,
	UsageSnapshot,
} from '../src/core/types.ts';

/** A credential is just a token here, plus when it was issued when that matters. */
export function cred(token: string, issued = 0): Credential {
	return issued > 0 ? { token, issued } : { token };
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
	identifyFails = false;
	/** When set, every refresh rotates the token by appending this. */
	rotate = '';
	running: RunningProcess[] = [];
	/** Where the fake agent keeps its everyday setup; a test points this somewhere. */
	home = '';
	seeded: string[] = [];
	readonly session: SessionSupport;

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
		};
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
		const read = this.readings.get(tokenOf(credential));
		if (!read) throw new Error('usage request failed with 401');
		return read();
	}

	async refreshIfNeeded(credential: Credential): Promise<Credential> {
		this.calls.refresh += 1;
		if (!this.rotate) return credential;
		const next = cred(tokenOf(credential) + this.rotate);
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
