import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { forgivenNames, rememberManualSwitch, tick } from '../src/core/auto.ts';
import { collectState } from '../src/core/collect.ts';
import { classify, ServiceError } from '../src/core/errors.ts';
import { readHistory } from '../src/core/history.ts';
import { heldByOpenSession } from '../src/core/hold.ts';
import {
	accountsFor,
	loadRegistry,
	removeAccount,
	updateRegistry,
	upsertAccount,
} from '../src/core/registry.ts';
import { renewSaved } from '../src/core/renew.ts';
import { prepareSession, sessionDir } from '../src/core/session.ts';
import { loadSettings, setSetting } from '../src/core/settings.ts';
import { activate } from '../src/core/switch.ts';
import { holdSwitch } from '../src/core/switch-lock.ts';
import type { AccountRecord, UsageSnapshot } from '../src/core/types.ts';
import { dropCredential, loadCredential, storeCredential } from '../src/core/vault.ts';
import { clearRunMark, markedRunning } from '../src/providers/process.ts';
import { cred, type FakeProvider, fakeProviders, tokenOf } from './fake-provider.ts';
import { withHome } from './helpers.ts';

const T = Date.parse('2026-09-16T12:00:00Z');

function reading(percent: number, resetsInHours = 24): UsageSnapshot {
	return {
		fetchedAt: new Date(T).toISOString(),
		windows: [
			{
				key: 'five_hour',
				label: '5h',
				percent: 1,
				resetsAt: new Date(T + 3_600_000).toISOString(),
			},
			{
				key: 'seven_day',
				label: 'week',
				percent,
				resetsAt: new Date(T + resetsInHours * 3_600_000).toISOString(),
			},
		],
	};
}

async function world(): Promise<{
	providers: ReturnType<typeof fakeProviders>;
	a: AccountRecord;
	b: AccountRecord;
}> {
	const providers = fakeProviders();
	const claude = providers.claude;
	const a = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'a@example.com' }),
	);
	const b = await updateRegistry((registry) =>
		upsertAccount(registry, { provider: 'claude', email: 'b@example.com' }),
	);
	await updateRegistry((registry) => {
		registry.active.claude = a.id;
	});
	await storeCredential(a, cred('A'));
	await storeCredential(b, cred('B'));
	claude.identities.set('A', { email: 'a@example.com' });
	claude.identities.set('B', { email: 'b@example.com' });
	claude.readings.set('A', () => reading(50));
	claude.readings.set('B', () => reading(10));
	claude.installed = cred('A');
	return { providers, a, b };
}

/** A held account's saved login comes back as it is: nothing renews it. */
async function expectHeld(provider: FakeProvider, account: AccountRecord): Promise<void> {
	const before = provider.calls.refresh;
	expect(tokenOf((await renewSaved(provider, account)) ?? {})).toBe('A');
	expect(provider.calls.refresh).toBe(before);
}

describe('an agent that keeps its login until it restarts', () => {
	test('the sessions open at a switch are remembered against the account left, and its login is not renewed while one is', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			providers.claude.rotate = '+';
			await activate('claude', b.id, { providers, now: T });
			const left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.heldBy).toEqual([4242]);
			const before = providers.claude.calls.refresh;
			await expectHeld(providers.claude, a);
			expect(providers.claude.calls.refresh).toBe(before);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
		});
	});

	test('once those sessions are gone the login is renewed again, and the record is cleared', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			providers.claude.running = [{ pid: 9999, command: 'a later session' }];
			providers.claude.rotate = '+';
			expect(tokenOf((await renewSaved(providers.claude, a)) ?? {})).toBe('A+');
			const left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.heldBy).toBeUndefined();
		});
	});

	test('when the running agents cannot be listed, the login is taken to be held', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			providers.claude.scanFailure = new Error('ps failed');
			await expectHeld(providers.claude, a);
		});
	});

	test('a held login whose key has run out is not renewed either, and says why without calling the login dead', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await storeCredential(a, cred('A', 0, T - 60_000));
			providers.claude.installed = cred('A', 0, T - 60_000);
			await activate('claude', b.id, { providers, now: T });
			providers.claude.rotate = '+';
			const attempt = renewSaved(providers.claude, a);
			await expect(attempt).rejects.toThrow('may still be in use by an open');
			expect(classify(await attempt.catch((error: unknown) => error))).not.toBe('auth');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
		});
	});

	test('a held account is still read, with the key it has, so its numbers and the brake keep up', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			providers.claude.rotate = '+';
			providers.claude.readings.set('A', () => reading(60));
			const state = await collectState({ providers, now: T, force: true, awake: async () => true });
			const shown = state.providers.claude.accounts.find((account) => account.id === a.id);
			expect(shown?.usage?.error).toBeUndefined();
			expect(shown?.usage?.windows[1]?.percent).toBe(60);
			expect(providers.claude.refreshesOf.get('A') ?? 0).toBe(0);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
		});
	});

	test('the automatic pass does not move back to a held account; it takes the next one with room', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T, manual: true });
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await storeCredential(c, cred('C'));
			providers.claude.identities.set('C', { email: 'c@example.com' });
			providers.claude.readings.set('A', () => reading(10, 1));
			providers.claude.readings.set('B', () => reading(100));
			providers.claude.readings.set('C', () => reading(50, 100));
			providers.claude.rotate = '+';
			const reports = await tick({ providers, now: T + 3_600_000 });
			expect(reports).toEqual([
				expect.objectContaining({ provider: 'claude', outcome: 'switched', to: 'c@example.com' }),
			]);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
		});
	});

	test('an automatic switch to a held account is refused, and changes nothing', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			await expect(activate('claude', a.id, { providers, now: T })).rejects.toThrow(
				'not moving to it automatically',
			);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});

	test('switching back to the account by hand goes ahead, unrenewed, and clears the record', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			await activate('claude', a.id, { providers, now: T, manual: true });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
			const accounts = (await loadRegistry()).accounts;
			expect(accounts.find((account) => account.id === a.id)?.heldBy).toBeUndefined();
			expect(accounts.find((account) => account.id === b.id)?.heldBy).toEqual([4242]);
		});
	});

	test('the hold is in place before the login is replaced, so a renewal at that moment is refused', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			providers.claude.rotate = '+';
			let during: unknown;
			providers.claude.afterWrite = async () => {
				providers.claude.afterWrite = null;
				during = tokenOf((await renewSaved(providers.claude, a)) ?? {});
			};
			await activate('claude', b.id, { providers, now: T });
			expect(during).toBe('A');
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
		});
	});

	test('a session that starts while the switch is under way holds the login left too', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [];
			providers.claude.duringRefresh = async () => {
				providers.claude.duringRefresh = null;
				// It starts while the new account's login is being renewed, and reads the old one.
				providers.claude.running = [{ pid: 5555, command: 'agent started mid-switch' }];
			};
			let during: unknown;
			providers.claude.afterWrite = async () => {
				providers.claude.afterWrite = null;
				providers.claude.rotate = '+';
				during = tokenOf((await renewSaved(providers.claude, a)) ?? {});
			};
			await activate('claude', b.id, { providers, now: T });
			expect(during).toBe('A');
			const left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.heldBy).toEqual([5555]);
			expect(left?.holdUnsettled).toBeUndefined();
			await expectHeld(providers.claude, a);
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A');
		});
	});

	test('the switch itself lists the agents running once the login is in, and records them', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [];
			providers.claude.duringRefresh = async () => {
				providers.claude.duringRefresh = null;
				providers.claude.running = [{ pid: 5555, command: 'agent started mid-switch' }];
			};
			await activate('claude', b.id, { providers, now: T });
			const left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.heldBy).toEqual([5555]);
			expect(left?.holdUnsettled).toBeUndefined();
			providers.claude.rotate = '+';
			await expectHeld(providers.claude, a);
		});
	});

	test('when the agents cannot be listed once the login is in, the hold stays until they can', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [];
			providers.claude.afterWrite = () => {
				providers.claude.afterWrite = null;
				providers.claude.scanFailure = new Error('ps failed');
			};
			await activate('claude', b.id, { providers, now: T });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
			let left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.holdUnsettled).toBe(true);
			providers.claude.rotate = '+';
			await expectHeld(providers.claude, a);
			providers.claude.scanFailure = null;
			providers.claude.running = [{ pid: 7777, command: 'agent' }];
			await expectHeld(providers.claude, a);
			left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.heldBy).toEqual([7777]);
			expect(left?.holdUnsettled).toBeUndefined();
			providers.claude.running = [];
			expect(tokenOf((await renewSaved(providers.claude, a)) ?? {})).toBe('A+');
		});
	});

	test('with no agent running before or after the switch, nothing holds the login left', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [];
			await activate('claude', b.id, { providers, now: T });
			const left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.heldBy).toBeUndefined();
			expect(left?.holdUnsettled).toBeUndefined();
			providers.claude.rotate = '+';
			expect(tokenOf((await renewSaved(providers.claude, a)) ?? {})).toBe('A+');
		});
	});

	test('when the running agents cannot be listed, the switch is refused and nothing changes', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.scanFailure = new Error('ps failed');
			await expect(activate('claude', b.id, { providers, now: T })).rejects.toThrow(
				'could not tell whether',
			);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
			expect(providers.claude.calls.write).toBe(0);
		});
	});

	test('an agent that picks a new login up as it runs is switched even when they cannot be listed', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.scanFailure = new Error('ps failed');
			await activate('claude', b.id, { providers, now: T });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});

	test('a held account cannot be run on its own, which would put a second copy of its login in use', async () => {
		await withHome(async (home) => {
			const { providers, a, b } = await world();
			providers.claude.home = join(home, 'agent');
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			await expect(prepareSession(providers.claude, a)).rejects.toThrow(
				'may still be in use by an open',
			);
			expect(await providers.claude.session.readLogin(sessionDir(providers.claude, a))).toBeNull();
			providers.claude.running = [];
			const session = await prepareSession(providers.claude, a);
			expect(tokenOf((await providers.claude.session.readLogin(session.dir)) ?? {})).toBe('A');
		});
	});

	test('preparing a session waits for a switch under way, then sees the hold that switch left', async () => {
		await withHome(async (home) => {
			const { providers, a } = await world();
			providers.claude.home = join(home, 'agent');
			await updateRegistry((registry) => {
				registry.active.claude = 'someone-else';
			});
			const lock = await holdSwitch('claude');
			const pending = prepareSession(providers.claude, a).catch((error: unknown) => error);
			await Bun.sleep(20);
			// While the session waited, a switch left this account held.
			await updateRegistry((registry) => {
				const record = registry.accounts.find((account) => account.id === a.id);
				if (record) record.heldBy = [4242];
			});
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await lock.release();
			expect(String(await pending)).toContain('may still be in use by an open');
			expect(await providers.claude.session.readLogin(sessionDir(providers.claude, a))).toBeNull();
		});
	});

	test('a session is not prepared for the account that became the one in use meanwhile', async () => {
		await withHome(async (home) => {
			const { providers, a } = await world();
			providers.claude.home = join(home, 'agent');
			await expect(prepareSession(providers.claude, a)).rejects.toThrow(
				'became the account in use',
			);
		});
	});

	test('the terminal asking for a session is recorded as running there before a switch can act', async () => {
		await withHome(async (home) => {
			const { providers, b } = await world();
			providers.claude.home = join(home, 'agent');
			const session = await prepareSession(providers.claude, b, { reserveFor: process.pid });
			expect(await markedRunning(session.dir)).toBe(true);
			await clearRunMark(session.dir, process.pid);
		});
	});

	test('a hold set while a check was listing the agents is kept, and counts as held', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			await updateRegistry((registry) => {
				const record = registry.accounts.find((account) => account.id === a.id);
				if (record) record.heldBy = [999];
			});
			const list = providers.claude.runningProcesses.bind(providers.claude);
			providers.claude.runningProcesses = async () => {
				// Meanwhile an import, or a switch, sets a hold of its own.
				await updateRegistry((registry) => {
					const record = registry.accounts.find((account) => account.id === a.id);
					if (record) record.holdUnsettled = true;
				});
				return list();
			};
			providers.claude.running = [];
			expect(await heldByOpenSession(providers.claude, a)).toBe(true);
			const record = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(record?.holdUnsettled).toBe(true);
			expect(record?.heldBy).toBeUndefined();
		});
	});

	test('an agent that picks a new login up as it runs holds nothing', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			const left = (await loadRegistry()).accounts.find((account) => account.id === a.id);
			expect(left?.heldBy).toBeUndefined();
		});
	});

	test('what holds a login never reaches the board', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.liveSwap = false;
			providers.claude.running = [{ pid: 4242, command: 'agent' }];
			await activate('claude', b.id, { providers, now: T });
			const state = await collectState({ providers, now: T, awake: async () => true });
			const shown = state.providers.claude.accounts.find((account) => account.id === a.id);
			expect(shown).toBeDefined();
			expect('heldBy' in (shown ?? {})).toBe(false);
		});
	});
});

describe('switching', () => {
	test('a login in use that cannot be read is not overwritten', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.readFailure = new Error('security: timed out');
			await expect(activate('claude', b.id, { providers, now: T })).rejects.toThrow(
				'could not read the login in use (security: timed out) - not switching, so nothing is lost',
			);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
			expect(providers.claude.calls.write).toBe(0);
		});
	});

	test('installs the saved login and records which account is in use', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			const result = await activate('claude', b.id, { providers, now: T });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
			expect(result).toMatchObject({
				from: 'a@example.com',
				fromId: a.id,
				to: 'b@example.com',
				alreadyActive: false,
			});
			expect((await loadRegistry()).active.claude).toBe(b.id);
		});
	});

	test('switching to the account already in use changes nothing', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			// The agent rotated its token since the vault copy was saved.
			providers.claude.installed = cred('A-rotated');
			providers.claude.identities.set('A-rotated', { email: 'a@example.com' });
			const result = await activate('claude', a.id, { providers, now: T });
			expect(result.alreadyActive).toBe(true);
			expect(providers.claude.calls.write).toBe(0);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A-rotated');
		});
	});

	test('the outgoing login is saved under the account it belongs to, not the one last recorded', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			// Signed in to B by hand; hotseat still thinks A is in use.
			providers.claude.installed = cred('B-newer');
			providers.claude.identities.set('B-newer', { email: 'b@example.com' });
			const result = await activate('claude', a.id, { providers, now: T });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B-newer');
			expect(result.from).toBe('b@example.com');
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('a login in use that belongs to no saved account is kept as a new account first', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.installed = cred('C');
			providers.claude.identities.set('C', { email: 'c@example.com', plan: 'pro' });
			const result = await activate('claude', b.id, { providers, now: T });
			const saved = accountsFor(await loadRegistry(), 'claude').find(
				(account) => account.email === 'c@example.com',
			);
			expect(saved).toBeDefined();
			expect(tokenOf((await loadCredential(saved ?? { id: '' })) ?? {})).toBe('C');
			expect(result.savedLogin).toEqual({ email: 'c@example.com', slot: saved?.slot ?? 0 });
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});

	test('a token refreshed during the switch is saved before it is installed', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.rotate = '+';
			await activate('claude', b.id, { providers, now: T });
			expect(tokenOf((await loadCredential(b)) ?? {})).toBe('B+');
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B+');
		});
	});
});

describe('switching automatically', () => {
	test('moves off an account that reached the limit, to the one that resets soonest with room', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await storeCredential(c, cred('C'));
			providers.claude.identities.set('C', { email: 'c@example.com' });
			providers.claude.readings.set('A', () => reading(95));
			providers.claude.readings.set('B', () => reading(40, 120));
			providers.claude.readings.set('C', () => reading(60, 6));
			const reports = await tick({ providers, now: T });
			expect(reports).toEqual([
				expect.objectContaining({ provider: 'claude', outcome: 'switched', to: 'c@example.com' }),
			]);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('C');
			expect((await readHistory())[0]).toMatchObject({
				reason: 'auto',
				to: 'c@example.com',
				leftAtPercent: 95,
			});
			expect(b.id).toBeDefined();
		});
	});

	test('moves on when the week of the account in use resets and another account resets sooner', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.readings.set('A', () => reading(3, 164));
			providers.claude.readings.set('B', () => reading(48, 51));
			const reports = await tick({ providers, now: T });
			expect(reports[0]).toMatchObject({
				provider: 'claude',
				outcome: 'switched',
				trigger: 'expiring',
				to: 'b@example.com',
				detail: 'switched to b@example.com, whose week resets sooner',
			});
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
			expect((await loadRegistry()).active.claude).toBe(b.id);
			const again = await tick({ providers, now: T + 3_600_000 });
			expect(again[0]?.outcome).toBe('holding');
		});
	});

	test('an account left for one whose week resets sooner can be gone back to once that one fills', async () => {
		await withHome(async () => {
			const { providers } = await world();
			providers.claude.readings.set('A', () => reading(85, 100));
			providers.claude.readings.set('B', () => reading(80, 20));
			const first = await tick({ providers, now: T });
			expect(first[0]).toMatchObject({
				outcome: 'switched',
				trigger: 'expiring',
				to: 'b@example.com',
			});
			providers.claude.readings.set('B', () => reading(92, 20));
			const second = await tick({ providers, now: T + 600_000 });
			expect(second[0]).toMatchObject({
				outcome: 'switched',
				trigger: 'proactive',
				to: 'a@example.com',
			});
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('an account chosen by hand before its week was known stays until the first week seen for it resets', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent: 1,
						resetsAt: new Date(T + 3_600_000).toISOString(),
					},
				],
			}));
			providers.claude.readings.set('B', () => reading(48, 51));
			const before = await collectState({ providers, now: T });
			const memory = await rememberManualSwitch({
				provider: 'claude',
				state: before.providers.claude,
				fromId: b.id,
				toId: a.id,
				settings: await loadSettings(),
				now: T,
			});
			expect(memory.chosenResetAt).toBeNull();
			providers.claude.readings.set('A', () => reading(3, 164));
			const first = await tick({ providers, now: T + 3_600_000 });
			expect(first[0]).toMatchObject({
				outcome: 'holding',
				detail: 'staying on the account you chose until its week resets',
			});
			const stored = await Bun.file(join(process.env.HOTSEAT_HOME ?? '', 'auto-state.json')).json();
			expect(stored.memory.claude.chosenResetAt).toBe(T + 164 * 3_600_000);
			expect((await tick({ providers, now: T + 7_200_000 }))[0]?.outcome).toBe('holding');
			providers.claude.readings.set('A', () => reading(3, 400));
			const rolled = await tick({ providers, now: T + 10_800_000 });
			expect(rolled[0]).toMatchObject({
				outcome: 'switched',
				trigger: 'expiring',
				to: 'b@example.com',
			});
		});
	});

	test('an account chosen by hand before its week was known is held only through the first week seen, even when nothing resets sooner then', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.readings.set('A', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent: 1,
						resetsAt: new Date(T + 3_600_000).toISOString(),
					},
				],
			}));
			providers.claude.readings.set('B', () => reading(10, 100));
			const before = await collectState({ providers, now: T });
			await rememberManualSwitch({
				provider: 'claude',
				state: before.providers.claude,
				fromId: b.id,
				toId: a.id,
				settings: await loadSettings(),
				now: T,
			});
			providers.claude.readings.set('A', () => reading(3, 20));
			expect((await tick({ providers, now: T + 3_600_000 }))[0]?.outcome).toBe('holding');
			providers.claude.readings.set('A', () => reading(3, 188));
			const rolled = await tick({ providers, now: T + 7_200_000 });
			expect(rolled[0]).toMatchObject({
				outcome: 'switched',
				trigger: 'expiring',
				to: 'b@example.com',
			});
		});
	});

	test('holding a hand-chosen account to its first week never rewrites a switch made by hand meanwhile', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			const noWeek = (): UsageSnapshot => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent: 1,
						resetsAt: new Date(T + 3_600_000).toISOString(),
					},
				],
			});
			providers.claude.readings.set('A', noWeek);
			providers.claude.readings.set('B', () => reading(48, 51));
			const first = await collectState({ providers, now: T });
			await rememberManualSwitch({
				provider: 'claude',
				state: first.providers.claude,
				fromId: b.id,
				toId: a.id,
				settings: await loadSettings(),
				now: T,
			});
			providers.claude.readings.set('A', () => reading(3, 164));
			providers.claude.readings.set('B', noWeek);
			providers.claude.fetchDelayMs = 150;
			const automatic = tick({ providers, now: T + 3_600_000 });
			while (providers.claude.calls.fetchUsage === 0) await Bun.sleep(5);
			providers.claude.fetchDelayMs = 0;
			const byHand = await holdSwitch('claude');
			const second = await collectState({ providers, now: T + 3_600_000 });
			await activate('claude', b.id, { providers, now: T + 3_600_000 });
			await rememberManualSwitch({
				provider: 'claude',
				state: second.providers.claude,
				fromId: a.id,
				toId: b.id,
				settings: await loadSettings(),
				now: T + 3_600_000,
			});
			await byHand.release();
			await automatic;
			const stored = await Bun.file(join(process.env.HOTSEAT_HOME ?? '', 'auto-state.json')).json();
			expect(stored.memory.claude).toMatchObject({ lastSwitchTo: b.id, chosenResetAt: null });
		});
	});

	test('an account chosen by hand is remembered with the week it was chosen in', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			providers.claude.readings.set('A', () => reading(3, 164));
			providers.claude.readings.set('B', () => reading(48, 51));
			const before = await collectState({ providers, now: T });
			const memory = await rememberManualSwitch({
				provider: 'claude',
				state: before.providers.claude,
				fromId: b.id,
				toId: a.id,
				settings: await loadSettings(),
				now: T,
			});
			expect(memory.chosenResetAt).toBe(T + 164 * 3_600_000);
			const reports = await tick({ providers, now: T + 3_600_000 });
			expect(reports[0]).toMatchObject({
				outcome: 'holding',
				detail: 'staying on the account you chose until its week resets',
			});
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('holds while the account in use is under the limit', async () => {
		await withHome(async () => {
			const { providers } = await world();
			const reports = await tick({ providers, now: T });
			expect(reports[0]?.outcome).toBe('holding');
			expect(reports[0]?.detail).toBe('at 50%, below the 90% limit');
			expect(providers.claude.calls.write).toBe(0);
		});
	});

	test('a login that fails to read three times in a row is switched away from', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await tick({ providers, now: T });
			providers.claude.readings.delete('A');
			const step = 4 * 60_000;
			const outcomes: string[] = [];
			for (let n = 1; n <= 3; n += 1) {
				const [report] = await tick({ providers, now: T + n * step });
				outcomes.push(report?.outcome ?? '');
			}
			expect(outcomes).toEqual(['holding', 'holding', 'switched']);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});

	test('a cached failure seen again before the next read does not count twice', async () => {
		await withHome(async () => {
			const { providers } = await world();
			await tick({ providers, now: T });
			providers.claude.readings.delete('A');
			const outcomes: string[] = [];
			for (let n = 1; n <= 3; n += 1) {
				const [report] = await tick({ providers, now: T + 4 * 60_000 + n * 1000 });
				outcomes.push(report?.outcome ?? '');
			}
			expect(outcomes).toEqual(['holding', 'holding', 'holding']);
		});
	});
});

describe('switching carefully', () => {
	test('refuses to switch when it cannot tell whose login is installed, so nothing is lost', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.installed = cred('X');
			providers.claude.identifyFails = true;
			await expect(activate('claude', b.id, { providers, now: T })).rejects.toThrow(
				/could not tell whose login/,
			);
			expect(providers.claude.calls.write).toBe(0);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('X');
		});
	});

	test('does not save an older outgoing login over a newer saved one', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			await storeCredential(a, cred('A-new', 300));
			providers.claude.installed = cred('A-old', 100);
			providers.claude.identities.set('A-old', { email: 'a@example.com' });
			await activate('claude', b.id, { providers, now: T });
			expect(tokenOf((await loadCredential(a)) ?? {})).toBe('A-new');
		});
	});

	test('refuses to switch onto an account that is open in another terminal', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			await prepareSession(providers.claude, b);
			providers.claude.runningIn.add(sessionDir(providers.claude, b));
			await expect(activate('claude', b.id, { providers, now: T })).rejects.toThrow(
				/open in another terminal/,
			);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('tells the agent who is signed in after a switch', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.identities.set('B', { email: 'b@example.com', organizationId: 'org-b' });
			await activate('claude', b.id, { providers, now: T });
			expect(providers.claude.recorded).toEqual([
				{ email: 'b@example.com', organizationId: 'org-b' },
			]);
		});
	});
});

describe('when the first choice cannot be used', () => {
	async function three(): Promise<Awaited<ReturnType<typeof world>> & { c: AccountRecord }> {
		const base = await world();
		const c = await updateRegistry((registry) =>
			upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
		);
		await storeCredential(c, cred('C'));
		base.providers.claude.identities.set('C', { email: 'c@example.com' });
		base.providers.claude.readings.set('A', () => reading(95));
		base.providers.claude.readings.set('B', () => reading(40, 120));
		base.providers.claude.readings.set('C', () => reading(60, 6));
		return { ...base, c };
	}

	test('the next account in line is tried', async () => {
		await withHome(async () => {
			const { providers, c } = await three();
			await collectState({ providers, now: T });
			await dropCredential(c);
			const reports = await tick({ providers, now: T });
			expect(reports[0]).toMatchObject({ outcome: 'switched', to: 'b@example.com' });
			expect(reports[0]?.detail).toContain('c@example.com');
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});

	test('an account whose login the service refused is never chosen', async () => {
		await withHome(async () => {
			const { providers } = await three();
			providers.claude.failures.set('C', new ServiceError('usage request failed with 401', 401));
			const reports = await tick({ providers, now: T });
			expect(reports[0]).toMatchObject({ outcome: 'switched', to: 'b@example.com' });
		});
	});
});

describe('a switch you made by hand', () => {
	test('is not undone by the automatic pass that follows it', async () => {
		await withHome(async () => {
			const { providers, a, b } = await world();
			// b is out of room on a model limit you count, and you pick it anyway.
			providers.claude.readings.set('B', () => ({
				fetchedAt: new Date(T).toISOString(),
				windows: [
					{
						key: 'five_hour',
						label: '5h',
						percent: 14,
						resetsAt: new Date(T + 3_600_000).toISOString(),
					},
					{
						key: 'seven_day',
						label: 'week',
						percent: 67,
						resetsAt: new Date(T + 14 * 3_600_000).toISOString(),
					},
					{
						key: 'weekly_scoped:fable',
						label: 'Fable',
						percent: 100,
						resetsAt: new Date(T + 14 * 3_600_000).toISOString(),
					},
				],
			}));
			await setSetting('autoModelLimits', 'fable');
			const settings = await loadSettings();
			const state = await collectState({ providers, now: T });
			const target = state.providers.claude.accounts.find((account) => account.id === b.id);

			await activate('claude', b.id, { providers, now: T });
			const memory = await rememberManualSwitch({
				provider: 'claude',
				state: state.providers.claude,
				fromId: a.id,
				toId: b.id,
				settings,
				now: T,
			});
			expect(memory.forgiven).toEqual([
				{ key: 'weekly_scoped:fable', resetsAt: new Date(T + 14 * 3_600_000).toISOString() },
			]);
			expect(forgivenNames(memory, target)).toEqual(['Fable']);

			const reports = await tick({ providers, now: T + 1000 });
			// The full model limit is left out, so the weekly window is judged,
			// and you stay where you put yourself.
			expect(reports[0]?.outcome).toBe('holding');
			expect(reports[0]?.detail).toBe('at 67%, below the 90% limit');
			expect(tokenOf(providers.claude.installed ?? {})).toBe('B');
		});
	});
});

describe('switching while the Mac sleeps', () => {
	test('a pass while the Mac is only half awake reads nothing and switches nothing', async () => {
		await withHome(async () => {
			const { providers } = await world();
			providers.claude.readings.set('A', () => reading(95));
			const reports = await tick({ providers, now: T, awake: async () => false });
			expect(reports).toEqual([
				expect.objectContaining({
					provider: 'claude',
					outcome: 'holding',
					detail: 'the Mac is asleep - waiting until it wakes',
				}),
			]);
			expect(providers.claude.calls.fetchUsage).toBe(0);
			expect(providers.claude.calls.refresh).toBe(0);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});
});

describe('switching while something else changes', () => {
	test('a login the agent renewed while the switch was under way is never overwritten', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.rotate = '+';
			providers.claude.refreshDelayMs = 50;
			const switching = activate('claude', b.id, { providers, now: T });
			await Bun.sleep(20);
			providers.claude.installed = cred('A2');
			providers.claude.identities.set('A2', { email: 'a@example.com' });
			await expect(switching).rejects.toThrow(
				'the login in use changed while switching - not switching, so nothing is lost; try again',
			);
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A2');
		});
	});

	test('an account removed while the switch was under way is not put in use', async () => {
		await withHome(async () => {
			const { providers, b } = await world();
			providers.claude.identifyDelayMs = 50;
			const switching = activate('claude', b.id, { providers, now: T });
			await Bun.sleep(20);
			await updateRegistry((registry) => {
				removeAccount(registry, b.id);
			});
			await expect(switching).rejects.toThrow('no saved login for b@example.com - it was removed');
			expect(tokenOf(providers.claude.installed ?? {})).toBe('A');
		});
	});

	test('an automatic pass reading the accounts while a switch is made by hand stands down', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await storeCredential(c, cred('C'));
			providers.claude.identities.set('C', { email: 'c@example.com' });
			providers.claude.readings.set('A', () => reading(95));
			providers.claude.readings.set('B', () => reading(40, 6));
			providers.claude.readings.set('C', () => reading(60, 120));
			await setSetting('autoCooldownSeconds', '0');
			providers.claude.fetchDelayMs = 150;
			const automatic = tick({ providers, now: T });
			while (providers.claude.calls.fetchUsage === 0) await Bun.sleep(5);
			providers.claude.fetchDelayMs = 0;
			const byHand = await holdSwitch('claude');
			const before = await collectState({ providers, now: T });
			await activate('claude', c.id, { providers, now: T });
			await rememberManualSwitch({
				provider: 'claude',
				state: before.providers.claude,
				fromId: a.id,
				toId: c.id,
				settings: await loadSettings(),
				now: T,
			});
			await byHand.release();
			const reports = await automatic;
			expect(tokenOf(providers.claude.installed ?? {})).toBe('C');
			expect(reports[0]?.outcome).toBe('holding');
		});
	});

	test('a switch made by hand whose bookkeeping failed still stops an automatic pass decided before it', async () => {
		await withHome(async () => {
			const { providers } = await world();
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await storeCredential(c, cred('C'));
			providers.claude.identities.set('C', { email: 'c@example.com' });
			providers.claude.readings.set('A', () => reading(95));
			providers.claude.readings.set('B', () => reading(40, 6));
			providers.claude.readings.set('C', () => reading(60, 120));
			const byHand = await holdSwitch('claude');
			const automatic = tick({ providers, now: T });
			while (providers.claude.calls.fetchUsage === 0) await Bun.sleep(5);
			await Bun.sleep(150);
			await activate('claude', c.id, { providers, now: T });
			await byHand.release();
			const reports = await automatic;
			expect(tokenOf(providers.claude.installed ?? {})).toBe('C');
			expect(reports[0]).toMatchObject({
				outcome: 'holding',
				detail: 'the login in use changed while this pass was deciding - deciding again next pass',
			});
		});
	});

	test('an automatic switch decided before a switch made by hand stands down', async () => {
		await withHome(async () => {
			const { providers, a } = await world();
			const c = await updateRegistry((registry) =>
				upsertAccount(registry, { provider: 'claude', email: 'c@example.com' }),
			);
			await storeCredential(c, cred('C'));
			providers.claude.identities.set('C', { email: 'c@example.com' });
			providers.claude.readings.set('A', () => reading(95));
			providers.claude.readings.set('B', () => reading(40, 6));
			providers.claude.readings.set('C', () => reading(60, 120));
			const byHand = await holdSwitch('claude');
			const automatic = tick({ providers, now: T });
			while (providers.claude.calls.fetchUsage === 0) await Bun.sleep(5);
			await Bun.sleep(150);
			const before = await collectState({ providers, now: T });
			await activate('claude', c.id, { providers, now: T });
			await rememberManualSwitch({
				provider: 'claude',
				state: before.providers.claude,
				fromId: a.id,
				toId: c.id,
				settings: await loadSettings(),
				now: T,
			});
			await byHand.release();
			const reports = await automatic;
			expect(tokenOf(providers.claude.installed ?? {})).toBe('C');
			expect(reports[0]).toMatchObject({
				outcome: 'holding',
				detail:
					'the account in use was switched while this pass was deciding - deciding again next pass',
			});
		});
	});
});
