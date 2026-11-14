import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fs.ts';
import { hotseatHome } from './paths.ts';
import type { ProviderId } from './types.ts';

export type ServiceLevel = 'ok' | 'minor' | 'major' | 'critical' | 'maintenance';

/** What a service's own status page says about it right now. */
export interface ServiceStatus {
	level: ServiceLevel;
	/** The page's own words, with any open incident named. */
	summary: string;
	url: string;
	checkedAt: string;
	/** Whether the page lists this agent on its own, or speaks for a whole company. */
	scoped: boolean;
}

/**
 * Trouble worth showing: any in the agent's own entry, and only an outage on a
 * page that covers a whole company, where a small issue is usually about some
 * other product.
 */
export function worthShowing(status: ServiceStatus | undefined): status is ServiceStatus {
	if (!status || status.level === 'ok') return false;
	return status.scoped || status.level === 'major' || status.level === 'critical';
}

interface Page {
	url: string;
	/** The part of the page that is this agent, when the page lists it apart. */
	component?: string;
}

/**
 * The public status pages. Claude's lists Claude Code on its own. OpenAI's has
 * no entry for the Codex CLI, so Codex is given the page as a whole, with the
 * open incidents named so it is plain what the trouble is about.
 */
const PAGES: Partial<Record<ProviderId, Page>> = {
	claude: { url: 'https://status.claude.com', component: 'Claude Code' },
	codex: { url: 'https://status.openai.com' },
};

/** A status page is read at most this often; it changes rarely, and slowly. */
export const STATUS_EVERY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface Summary {
	status?: { indicator?: string; description?: string };
	components?: { name?: string; status?: string }[];
	incidents?: { name?: string; status?: string }[];
}

const COMPONENT_LEVEL: Record<string, ServiceLevel> = {
	operational: 'ok',
	degraded_performance: 'minor',
	partial_outage: 'major',
	major_outage: 'critical',
	under_maintenance: 'maintenance',
};

const PAGE_LEVEL: Record<string, ServiceLevel> = {
	none: 'ok',
	minor: 'minor',
	major: 'major',
	critical: 'critical',
	maintenance: 'maintenance',
};

/** Turns a status page's summary into what hotseat shows, or nothing when it cannot be read. */
export function readSummary(
	payload: Summary,
	page: Page,
): Pick<ServiceStatus, 'level' | 'summary'> | undefined {
	const open = (payload.incidents ?? [])
		.filter((incident) => incident.status !== 'resolved' && incident.status !== 'postmortem')
		.map((incident) => incident.name)
		.filter((name): name is string => typeof name === 'string' && name.length > 0);
	const about = open.length > 0 ? `: ${open.join('; ')}` : '';
	if (page.component) {
		const part = payload.components?.find((component) => component.name === page.component);
		const level = part?.status ? COMPONENT_LEVEL[part.status] : undefined;
		if (!part || !level) return undefined;
		const words = (part.status ?? '').replaceAll('_', ' ');
		// Incidents are the page's, not this part's, so they are named only
		// when this part is itself in trouble.
		return { level, summary: `${page.component} is ${words}${level === 'ok' ? '' : about}` };
	}
	const level = PAGE_LEVEL[payload.status?.indicator ?? ''];
	if (!level) return undefined;
	return { level, summary: `${payload.status?.description ?? 'Status unknown'}${about}` };
}

type Kept = Partial<Record<ProviderId, ServiceStatus>>;

function keptPath(): string {
	return join(hotseatHome(), 'service-status.json');
}

/**
 * What each service's status page says, for the services asked about. A page
 * read under five minutes ago is not read again, and one that cannot be
 * reached keeps what it last said rather than going blank.
 */
export async function serviceStatuses(
	providers: readonly ProviderId[],
	now = Date.now(),
): Promise<Kept> {
	const kept = (await readJson<Kept>(keptPath()).catch(() => null)) ?? {};
	const result: Kept = {};
	let changed = false;
	await Promise.all(
		providers.map(async (provider) => {
			const page = PAGES[provider];
			if (!page) return;
			const before = kept[provider];
			if (before && now - Date.parse(before.checkedAt) < STATUS_EVERY_MS) {
				result[provider] = before;
				return;
			}
			try {
				const response = await fetch(`${page.url}/api/v2/summary.json`, {
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
					headers: { accept: 'application/json' },
				});
				if (!response.ok) throw new Error(`status page answered ${response.status}`);
				const read = readSummary((await response.json()) as Summary, page);
				if (!read) throw new Error('status page sent an answer hotseat cannot read');
				result[provider] = {
					...read,
					url: page.url,
					checkedAt: new Date(now).toISOString(),
					scoped: page.component !== undefined,
				};
				changed = true;
			} catch {
				if (before) result[provider] = before;
			}
		}),
	);
	if (changed) await writeJsonAtomic(keptPath(), { ...kept, ...result }).catch(() => undefined);
	return result;
}
