export type ProviderId = 'claude' | 'codex';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex'];

export interface AccountRecord {
	id: string;
	provider: ProviderId;
	email: string;
	slot: number;
	alias?: string;
	plan?: string;
	disabled: boolean;
	addedAt: string;
	lastActivatedAt?: string;
	/** The saved login: tokens and what the sign-in granted. Absent until saved. */
	login?: Credential;
}

export interface Registry {
	version: 1;
	accounts: AccountRecord[];
	active: Partial<Record<ProviderId, string>>;
	/** Entries in the file hotseat could not read. Kept as they are, never dropped. */
	unreadable: unknown[];
}

export interface UsageWindow {
	key: string;
	label: string;
	percent: number;
	resetsAt?: string;
}

export interface UsageSnapshot {
	/** When the numbers were read. A failed read keeps the numbers and this time. */
	fetchedAt: string;
	windows: UsageWindow[];
	spendPercent?: number;
	/** What the latest read said when it failed, with the last good numbers kept. */
	error?: string;
	/** Reads that have failed in a row, for deciding a login is gone. */
	failedReads?: number;
}

export type Credential = Record<string, unknown>;

export interface Identity {
	email: string;
	plan?: string;
	accountId?: string;
}

export interface RunningProcess {
	pid: number;
	command: string;
}

export interface Provider {
	readonly id: ProviderId;
	readonly displayName: string;
	readonly liveSwap: boolean;
	readAgentCredential(): Promise<Credential | null>;
	writeAgentCredential(credential: Credential): Promise<void>;
	identify(credential: Credential): Promise<Identity>;
	fetchUsage(credential: Credential): Promise<UsageSnapshot>;
	refreshIfNeeded(credential: Credential): Promise<Credential>;
	runningProcesses(): Promise<RunningProcess[]>;
}

/** An account as shown: everything but its login, which never leaves the file. */
export interface AccountState extends Omit<AccountRecord, 'login'> {
	usage?: UsageSnapshot;
}

export interface ProviderState {
	activeAccountId?: string;
	accounts: AccountState[];
}

export interface State {
	version: 1;
	updatedAt: string;
	providers: Record<ProviderId, ProviderState>;
}
