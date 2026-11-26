import type { FailureKind } from './errors.ts';
export type ProviderId = 'claude' | 'codex' | 'antigravity' | 'grok';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'grok', 'antigravity'];

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
	/**
	 * The fingerprint of the installed login the saved one renewed, kept until
	 * the renewal is installed, so the installed login can still be named as
	 * this account's after its saved copy was replaced.
	 */
	renewedFrom?: string;
	/**
	 * The fingerprint of the saved login as it was when it last went in use,
	 * or was last updated from the login in use. While the saved login is still
	 * that one, the login in use is its own copy, renewed by the agent, and
	 * replaces it when newer; once something else is saved, such as a fresh
	 * sign-in, the login in use no longer does.
	 */
	inUseFrom?: string;
	/**
	 * The agent processes that were running when this account was switched away
	 * from, for an agent that keeps its login until it restarts. While one is
	 * still running it may hold this login, so it is not renewed from here.
	 */
	heldBy?: number[];
	/**
	 * Set from the moment a switch away from this account begins until the
	 * agents running after it are known. While set, any agent found running may
	 * hold this login, so it is not renewed until those are known and gone.
	 */
	holdUnsettled?: boolean;
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
	/**
	 * How long this limit runs before it resets, when the service says. Without
	 * it, the limit is told apart by its key and name.
	 */
	span?: '5h' | 'week' | 'month';
	/** Left off the board because it was asked to be; still read, counted and recorded. */
	hidden?: boolean;
	/** It has reset since it was read, and nothing has been read of the new window yet. */
	cleared?: true;
	/** When this limit will be full at the pace it has been filling, if that is before it resets. */
	fullAt?: string;
	/** When the window that resets at `resetsAt` began, when the service says. */
	startsAt?: string;
	/** The last week of this limit, as evenly spaced values, oldest first. */
	trend?: number[];
}

/**
 * A free reset of some of an account's limits, granted by the service. hotseat
 * lists them, and uses one only when a person asks it to.
 */
export interface LimitReset {
	/** The service's own id for it. */
	id: string;
	/** What it is called, after what it clears: "Weekly reset", "Fable reset". */
	title: string;
	/** The limits it empties, by the names the board gives them. */
	clears: string[];
	/** The keys of the limits it may empty, for telling whether it has anything to clear. */
	windowKeys?: string[];
	/** It empties every limit the account reports, whichever those are. */
	clearsEvery?: true;
	/** It also empties a limit the board does not draw, which may be in use. */
	clearsUnseen?: true;
	/** It also empties a limit the board does not draw, which the service reports as empty. */
	clearsEmptyUnseen?: true;
	/** Every reset on this line, when several that read the same are shown as one. */
	ids?: string[];
	/** A limit it leaves running, but gives back what the cleared ones used of it. */
	givesBack?: string;
	/** When it can no longer be used. */
	expiresAt?: string;
	/** How many uses it has left, when more than one; the board counts alike resets together. */
	left?: number;
	/** Why it cannot be used right now, when it cannot. */
	blocked?: string;
	/** How the service describes it. */
	detail?: string;
}

/** What came of asking the service to use a reset. */
export interface ResetUse {
	/** The service reset the limits. */
	used: boolean;
	/** Why it did not, in words, when it did not. */
	refused?: string;
}

export interface UsageSnapshot {
	/** When the numbers were read. A failed read keeps the numbers and this time. */
	fetchedAt: string;
	windows: UsageWindow[];
	spendPercent?: number;
	/**
	 * The free limit resets the account holds, as the service last listed them:
	 * absent when it said nothing about them, empty when it said there are none.
	 */
	limitResets?: LimitReset[];
	/** When that list was read, which can be earlier than the numbers. */
	limitResetsReadAt?: string;
	/** The service listed resets hotseat could not tell apart, so the list is not the whole of them. */
	limitResetsIncomplete?: true;
	/**
	 * A limit the service keeps but the board does not draw is in use, so a
	 * reset that clears every limit has something to clear whatever the drawn
	 * ones say.
	 */
	otherLimitsInUse?: true;
	/** When the last of those undrawn limits in use resets, when the service says. */
	otherLimitsInUseUntil?: string;
	/**
	 * The list is the last one read, and the service has since said it holds a
	 * different number, so it is shown but not taken as current.
	 */
	limitResetsStale?: true;
	/**
	 * What a good read says when it brings no limits: the service answered, and
	 * has none to report for this account.
	 */
	note?: string;
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
	/** The service itself said whose this login is, rather than it being read from the login. */
	confirmed?: boolean;
	plan?: string;
	accountId?: string;
	organizationId?: string;
	organizationName?: string;
}

export interface RunningProcess {
	pid: number;
	command: string;
}

/** An installed login that holds nothing to sign in with. */
export interface SignedOut {
	/** The agent cleared it because the service would no longer renew it. */
	ended: boolean;
	/** Why the service stopped renewing it, in words, when the agent said. */
	reason?: string;
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
	/** Which of two copies of a login is fresher: above zero when the first is, below when the second is. */
	compareAge(a: Credential, b: Credential): number;
	/** Anything else the folder needs before the agent will start there. */
	seed?(dir: string): Promise<void>;
	/** Whether an agent is running out of that folder right now. */
	isRunning(dir: string): Promise<boolean>;
	/** Removes whatever the folder's login left outside it, such as a keychain item. */
	forget(dir: string): Promise<void>;
	/**
	 * Hands the machine-wide logins the session renewed, such as connector
	 * logins, back to the everyday setup, so no other terminal keeps a token
	 * the service has retired. Whether anything was handed back.
	 */
	carryBack?(dir: string): Promise<boolean>;
}

/** A usage reading the agent itself keeps, for the account it is signed in as. */
export interface LocalReading {
	accountId?: string;
	fetchedAtMs: number;
	windows: UsageWindow[];
}

export interface Provider {
	readonly id: ProviderId;
	readonly displayName: string;
	readonly liveSwap: boolean;
	readonly session: SessionSupport;
	readAgentCredential(): Promise<Credential | null>;
	writeAgentCredential(credential: Credential): Promise<void>;
	identify(credential: Credential): Promise<Identity>;
	/** Reads the account's usage. The last reading lets a provider reuse what changes rarely. */
	fetchUsage(credential: Credential, previous?: UsageSnapshot): Promise<UsageSnapshot>;
	refreshIfNeeded(credential: Credential): Promise<Credential>;
	runningProcesses(): Promise<RunningProcess[]>;
	/** Whether two copies of a login hold the same refresh token, so renewing one spends the other. */
	sharesToken(a: Credential, b: Credential): boolean;
	/** When the access token stops working, if the credential says. */
	expiresAt?(credential: Credential): number | undefined;
	/** Says how the installed login holds nothing to sign in with; undefined when it holds a login. */
	signedOut?(credential: Credential): SignedOut | undefined;
	/** When the sign-in a login comes from ends, after which it can no longer be renewed, if it says. */
	signInEndsAt?(credential: Credential): number | undefined;
	/** The service's id for the account a login belongs to, if the login says, even once cleared. */
	accountOf?(credential: Credential): string | undefined;
	/** Tells the agent's own records who is signed in now. */
	recordIdentity?(identity: Identity): Promise<void>;
	/** The agent's own latest reading of the account it is signed in as, if it keeps one. */
	localReading?(): Promise<LocalReading | null>;
	/**
	 * Spends one of the account's free limit resets. Only ever on a person's
	 * say-so. The request id names this one attempt: sent again, it asks for the
	 * same use rather than another. `stillWanted` is asked last, just before the
	 * request goes out; when it says no, nothing is sent and ResetNotSent is thrown.
	 */
	useReset?(
		credential: Credential,
		resetId: string,
		requestId: string,
		stillWanted?: () => boolean,
	): Promise<ResetUse>;
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
