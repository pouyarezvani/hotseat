import type {
	Credential,
	Identity,
	Provider,
	ProviderId,
	RunningProcess,
	UsageSnapshot,
} from '../src/core/types.ts';

/** A credential is just a token here; whatever else a real one carries is noise. */
export function cred(token: string): Credential {
	return { token };
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

	constructor(id: ProviderId) {
		this.id = id;
		this.displayName = id === 'claude' ? 'Claude' : 'Codex';
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
