import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Points hotseat at a throwaway home for the duration of a test, so every test
 * sees its own accounts, settings and history and none can affect the machine
 * they run on.
 */
export async function withHome<T>(work: (home: string) => Promise<T>): Promise<T> {
	const previous = process.env.HOTSEAT_HOME;
	const home = await mkdtemp(join(tmpdir(), 'hotseat-test-'));
	process.env.HOTSEAT_HOME = home;
	try {
		return await work(home);
	} finally {
		if (previous === undefined) delete process.env.HOTSEAT_HOME;
		else process.env.HOTSEAT_HOME = previous;
		await rm(home, { recursive: true, force: true });
	}
}

/** Fixed rather than derived from the clock, so two calls compare equal. */
export const CREDENTIAL_EXPIRY = Date.parse('2099-01-01T00:00:00Z');

export function credential(token: string): Record<string, unknown> {
	return {
		claudeAiOauth: {
			accessToken: token,
			refreshToken: `${token}-refresh`,
			expiresAt: CREDENTIAL_EXPIRY,
			scopes: ['user:profile', 'user:inference'],
		},
	};
}
