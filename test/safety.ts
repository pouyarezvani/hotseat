import { join } from 'node:path';

// Loaded before every test file. No test reaches a real service or this Mac's
// keychain: a request fails, naming what was asked for, and the keychain tool
// is swapped for a stand-in that finds nothing and stores nothing. A test that
// needs an answer from either gives its own fake.

globalThis.fetch = Object.assign(
	async (input: string | URL | Request): Promise<Response> => {
		throw new Error(`a test tried to reach ${String(input)} - give it a fake answer`);
	},
	{ preconnect: () => undefined },
) as unknown as typeof fetch;

const standIn = join(import.meta.dir, 'fixtures', 'no-keychain.sh');
const isKeychainTool = (program: string | undefined): boolean =>
	program === '/usr/bin/security' || program === 'security';
const spawn = Bun.spawn;

Bun.spawn = ((first: string[] | { cmd: string[] }, options?: object) => {
	if (Array.isArray(first)) {
		const [program, ...rest] = first;
		return spawn(isKeychainTool(program) ? [standIn, ...rest] : first, options as never);
	}
	const [program, ...rest] = first.cmd;
	return spawn(isKeychainTool(program) ? { ...first, cmd: [standIn, ...rest] } : first);
}) as typeof Bun.spawn;
