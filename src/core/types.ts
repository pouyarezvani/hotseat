import type { FailureKind } from './errors.ts';
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
	/** What kind of failure that was. Only an auth failure counts against the login. */
	errorKind?: FailureKind;
	/** Reads refused as a bad login, in a row, for deciding the login is gone. */
	failedReads?: number;
	/** When the service said to try again, after telling us to slow down. */
	retryAt?: string;
}

export type Credential = Record<string, unknown>;

export interface Identity {
	email: string;
	plan?: string;
	accountId?: string;
	organizationId?: string;
	organizationName?: string;
}

export interface RunningProcess {
	pid: number;
	command: string;
}

/**
 * How to run one command as a given account in one terminal, leaving the
 * login every other terminal uses alone. The agent is pointed at a folder of
 * its own; that folder links to the everyday setup and holds its own login.
 */
export interface SessionSupport {
	/** The variable that points the agent at a folder of its own. */
	readonly homeVariable: string;
	/** The folder the agent normally uses, whose setup a session shares. */
	sharedHome(): string;
	/** Entries of the shared home a session links to. Everything else stays its own. */
	readonly sharedEntries: readonly string[];
	/** The command to run when none is given. */
	readonly defaultCommand: string;
	/** Puts the login where the agent will look for it in that folder. */
	writeLogin(dir: string, credential: Credential): Promise<void>;
	/** The login the agent left in that folder, if any. */
	readLogin(dir: string): Promise<Credential | null>;
	/** When a login was issued, so a fresher copy can be told from a staler one. */
	issuedAt(credential: Credential): number;
	/** Anything else the folder needs before the agent will start there. */
	seed?(dir: string): Promise<void>;
	/** Whether an agent is running out of that folder right now. */
	isRunning(dir: string): Promise<boolean>;
	/** Removes whatever the folder's login left outside it, such as a keychain item. */
	forget(dir: string): Promise<void>;
}

export interface Provider {
	readonly id: ProviderId;
	readonly displayName: string;
	readonly liveSwap: boolean;
	readonly session: SessionSupport;
	readAgentCredential(): Promise<Credential | null>;
	writeAgentCredential(credential: Credential): Promise<void>;
	identify(credential: Credential): Promise<Identity>;
	fetchUsage(credential: Credential): Promise<UsageSnapshot>;
	refreshIfNeeded(credential: Credential): Promise<Credential>;
	runningProcesses(): Promise<RunningProcess[]>;
	/** When the access token stops working, if the credential says. */
	expiresAt?(credential: Credential): number | undefined;
	/** Tells the agent's own records who is signed in now. */
	recordIdentity?(identity: Identity): Promise<void>;
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
