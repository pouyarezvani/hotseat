#!/usr/bin/env bun
/**
 * One-time import of Claude accounts saved by a previously installed switcher,
 * so moving to hotseat does not cost you a sign-in. Reads only; it changes
 * nothing belonging to the other tool.
 *
 * Usage: bun run scripts/import-legacy.ts [--service <keychain service>]
 */
import { enroll } from '../src/core/enroll.ts';
import type { Credential } from '../src/core/types.ts';
import { isolateAccountKeys, keychainAccount } from '../src/providers/claude/keychain.ts';
import { problem, say, success } from '../src/ui/report.ts';
import { hint, theme } from '../src/ui/style.ts';

const SECURITY = '/usr/bin/security';

function flag(name: string, fallback: string): string {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const service = flag('--service', 'claude-swap');

async function entriesFor(service: string): Promise<string[]> {
	const proc = Bun.spawn([SECURITY, 'dump-keychain'], { stdout: 'pipe', stderr: 'ignore' });
	const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	const found = new Set<string>();
	const lines = text.split('\n');
	lines.forEach((line, index) => {
		if (!line.includes(`"svce"<blob>="${service}"`)) return;
		for (let back = index; back >= Math.max(0, index - 12); back -= 1) {
			const match = /"acct"<blob>="(.+)"/.exec(lines[back] ?? '');
			if (match?.[1]) {
				found.add(match[1]);
				return;
			}
		}
	});
	return [...found];
}

async function readEntry(account: string): Promise<Credential | null> {
	const proc = Bun.spawn([SECURITY, 'find-generic-password', '-s', service, '-a', account, '-w'], {
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) return null;
	const raw = text.replace(/\n$/, '');
	const decoded =
		/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
			? Buffer.from(raw, 'hex').toString('utf8')
			: raw;
	try {
		return JSON.parse(decoded) as Credential;
	} catch {
		return null;
	}
}

const t = theme();
say('');
say(hint(t, `reading saved Claude logins from the "${service}" keychain entries`));
say(hint(t, `as ${keychainAccount()}`));
say('');

// A ".prev" entry is a superseded copy kept for recovery; importing it would
// install a token the service has already rotated away from.
const candidates = (await entriesFor(service)).filter(
	(account) => account.startsWith('account-') && !account.endsWith('.prev'),
);

if (candidates.length === 0) {
	problem(`found nothing saved under "${service}"`);
	process.exit(1);
}

let imported = 0;
for (const entry of candidates) {
	const email = entry.replace(/^account-\d+-/, '');
	const credential = await readEntry(entry);
	if (!credential) {
		problem(`${email}: could not read its saved login`);
		continue;
	}
	try {
		const account = await enroll('claude', isolateAccountKeys(credential), email);
		success(`${account.email} is now Claude account ${account.slot}`);
		imported += 1;
	} catch (error) {
		problem(`${email}: ${(error as Error).message}`);
	}
}

say('');
say(hint(t, `imported ${imported} of ${candidates.length}`));
