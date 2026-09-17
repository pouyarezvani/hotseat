import {
	loop as autoLoop,
	tick as autoTick,
	forgivenNames,
	rememberManualSwitch,
} from './core/auto.ts';
import { collectState, PROVIDERS } from './core/collect.ts';
import {
	enroll,
	enrollFromToken,
	loginClaudeIsolated,
	loginCodexIsolated,
	publishState,
} from './core/enroll.ts';
import { readHistory, recordSwitch, type SwitchReason } from './core/history.ts';
import { listMappings, mappingFor, removeMapping, setMapping } from './core/mappings.ts';
import {
	findApp,
	installLoginItem,
	isRunning,
	loginItemInstalled,
	removeLoginItem,
	startMenuBar,
	stopMenuBar,
} from './core/menubar.ts';
import {
	accountsFor,
	findAccount,
	loadRegistry,
	migrateVault,
	removeAccount,
	setAlias,
	updateRegistry,
	upsertAccount,
} from './core/registry.ts';
import { captureSession, forgetSession, needsSession, prepareSession } from './core/session.ts';
import {
	DEFAULTS,
	describeSetting,
	isSettingKey,
	loadSettings,
	resetSetting,
	SETTING_KEYS,
	setSetting,
} from './core/settings.ts';
import { activate, nextAvailable, pickBest, rotateNext } from './core/switch.ts';
import { exportAccounts, importAccounts, moveSlot, purge, swapSlots } from './core/transfer.ts';
import { PROVIDER_IDS, type ProviderId } from './core/types.ts';
import { storeCredential } from './core/vault.ts';
import { renderBoard } from './ui/board.ts';
import { renderHelp } from './ui/help.ts';
import { closePrompt, isInteractive, select } from './ui/prompt.ts';
import { note, problem, say, step, success } from './ui/report.ts';
import { theme } from './ui/style.ts';
import { buildTitle, titleText } from './ui/title.ts';

function parseProvider(value: string | undefined): ProviderId {
	if (value === 'claude' || value === 'codex') return value;
	throw new Error(`unknown provider "${value ?? ''}" - expected one of ${PROVIDER_IDS.join(', ')}`);
}

function flagValue(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

async function resolve(providerId: ProviderId, selector: string | undefined) {
	if (!selector) throw new Error('name an account by its number, email, or the name you gave it');
	const registry = await loadRegistry();
	const account = findAccount(registry, providerId, selector);
	if (!account) throw new Error(`no ${providerId} account matches "${selector}"`);
	return account;
}

/** An entry in accounts.json that is not an account is left alone, and said. */
function warnUnreadable(registry: Awaited<ReturnType<typeof loadRegistry>>): void {
	const count = registry.unreadable.length;
	if (count === 0) return;
	const plural = count === 1 ? 'entry' : 'entries';
	note(
		`${count} ${plural} in accounts.json could not be read and ${count === 1 ? 'is' : 'are'} ignored. An account needs at least "provider" and "email".`,
	);
}

async function status(json: boolean, force: boolean): Promise<number> {
	const settings = await loadSettings();
	const state = await collectState({ force });
	if (json) {
		process.stdout.write(`${JSON.stringify({ ...state, settings })}\n`);
		return 0;
	}
	warnUnreadable(await loadRegistry());
	process.stdout.write(
		`\n${renderBoard(state, {
			theme: theme(),
			barWidth: settings.barWidth,
			now: Date.now(),
			modelLimits: settings.autoModelLimits,
		})}\n`,
	);
	return 0;
}

async function seat(
	providerId: ProviderId,
	accountId: string,
	reason: SwitchReason,
): Promise<number> {
	const provider = PROVIDERS[providerId];
	const settings = await loadSettings();
	const before = await collectState();
	const _leaving = before.providers[providerId].accounts.find(
		(account) => account.id === before.providers[providerId].activeAccountId,
	);
	const result = await activate(providerId, accountId);
	if (result.alreadyActive) {
		note(`${provider.displayName} is already using ${result.to}`);
		return 0;
	}
	if (result.savedLogin) {
		note(
			`the login that was in use, ${result.savedLogin.email}, was not saved yet - kept it as account ${result.savedLogin.slot}`,
		);
	}
	const now = Date.now();
	await recordSwitch({
		at: new Date(now).toISOString(),
		provider: providerId,
		...(result.from ? { from: result.from } : {}),
		to: result.to,
		reason,
	});
	const memory = await rememberManualSwitch({
		provider: providerId,
		state: before.providers[providerId],
		...(result.fromId ? { fromId: result.fromId } : {}),
		toId: result.toId,
		settings,
		now,
	});
	const arriving = before.providers[providerId].accounts.find(
		(account) => account.id === result.toId,
	);
	const forgiven = forgivenNames(memory, arriving);
	await publishState();
	success(`${provider.displayName} is now using ${result.to}`);
	if (forgiven.length > 0) {
		note(
			`${forgiven.join(' and ')} ${forgiven.length === 1 ? 'is' : 'are'} already full here - hotseat will stay put rather than moving you back.`,
		);
	}
	if (result.runningProcesses > 0) {
		const count = result.runningProcesses;
		const plural = count === 1 ? 'session' : 'sessions';
		note(
			provider.liveSwap
				? `${count} open ${plural}, including any in your editor, will pick this up shortly.`
				: `${count} open ${plural} still use the old account. Restart them to pick this up.`,
		);
	}
	return 0;
}

/** Shared by the three seat-picking commands so they cannot drift apart. */
async function seatPicked(
	providerId: ProviderId,
	pick: (
		state: Awaited<ReturnType<typeof collectState>>['providers'][ProviderId],
	) => { id: string; email: string } | undefined,
	reason: SwitchReason,
	emptyMessage: string,
): Promise<number> {
	const state = await collectState();
	const target = pick(state.providers[providerId]);
	if (!target) {
		process.stdout.write(`${emptyMessage}\n`);
		return 0;
	}
	return seat(providerId, target.id, reason);
}

async function capture(providerId: ProviderId, announce: boolean): Promise<number> {
	const provider = PROVIDERS[providerId];
	const credential = await provider.readAgentCredential();
	if (!credential) {
		problem(`no ${provider.displayName} account is signed in on this machine`);
		return 1;
	}
	const identity = await provider.identify(credential);
	const account = await updateRegistry((registry) =>
		upsertAccount(registry, {
			provider: providerId,
			email: identity.email,
			...(identity.plan ? { plan: identity.plan } : {}),
		}),
	);
	await storeCredential(account, credential);
	await updateRegistry((registry) => {
		registry.active[providerId] = account.id;
	});
	await publishState({ force: true });
	if (announce) {
		success(`saved ${identity.email} as ${provider.displayName} account ${account.slot}`);
	}
	return 0;
}

/**
 * Adds an account by signing in to it. Adding only ever appends to the list:
 * nothing already saved is signed out. Claude asks for a separate long-lived
 * token rather than replacing the current login, and Codex signs in against a
 * scratch directory because its own sign-in revokes whatever token is stored.
 */
async function addInteractive(): Promise<number> {
	const providerId = await select<ProviderId>('Add an account for which service?', [
		{ label: 'Claude', value: 'claude', hint: 'Claude Code' },
		{ label: 'Codex', value: 'codex', hint: 'OpenAI Codex' },
	]);

	if (providerId === 'codex') {
		closePrompt();
		say('');
		note('Your browser will open. Sign in as the account you want to add.');
		note('Nothing is signed out. The account you are using stays signed in.');
		const credential = await loginCodexIsolated();
		const account = await step('Saving the account', () => enroll('codex', credential));
		say('');
		success(`added ${account.email} as Codex account ${account.slot}`);
		return 0;
	}

	closePrompt();
	say('');
	note('Your browser will open. Sign in as the account you want to add.');
	note('Nothing is signed out. The account you are using stays signed in,');
	note('because this sign-in runs against its own scratch directory.');
	say('');
	const credential = await loginClaudeIsolated();
	const account = await step('Adding the account', () => enroll('claude', credential));
	say('');
	success(`added ${account.email} as Claude account ${account.slot}`);
	return 0;
}

async function showConfig(json: boolean): Promise<number> {
	const settings = await loadSettings();
	if (json) {
		process.stdout.write(`${JSON.stringify(settings)}\n`);
		return 0;
	}
	const width = Math.max(...SETTING_KEYS.map((key) => key.length));
	for (const key of SETTING_KEYS) {
		const value = Array.isArray(settings[key]) ? settings[key].join(',') : String(settings[key]);
		const marker = value === String(DEFAULTS[key]) ? ' ' : '*';
		process.stdout.write(
			`${marker} ${key.padEnd(width)}  ${value.padEnd(16)}${describeSetting(key)}\n`,
		);
	}
	return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	try {
		await migrateVault();
		switch (command) {
			case undefined:
			case 'status':
				return await status(rest.includes('--json'), rest.includes('--force'));
			case 'refresh':
				return await status(rest.includes('--json'), true);
			case 'title': {
				const settings = await loadSettings();
				const state = await collectState();
				const spans = buildTitle(state, settings);
				process.stdout.write(
					`${rest.includes('--json') ? JSON.stringify(spans) : titleText(spans)}\n`,
				);
				return 0;
			}
			case 'add': {
				if (rest[0]) return await capture(parseProvider(rest[0]), true);
				if (!isInteractive()) {
					throw new Error('name a provider, as in: hotseat add claude');
				}
				return await addInteractive();
			}
			case 'save':
				return await capture(parseProvider(rest[0]), true);
			case 'add-token': {
				const providerId = parseProvider(rest[0]);
				if (providerId !== 'claude') {
					throw new Error('setup tokens are a Claude feature - use "hotseat add codex" instead');
				}
				const raw =
					rest[1] && rest[1] !== '-' && !rest[1].startsWith('--')
						? rest[1]
						: await new Response(Bun.stdin.stream()).text();
				const email = flagValue(rest, '--email');
				const account = await enrollFromToken(raw, {
					...(email ? { email } : {}),
					replace: rest.includes('--replace'),
				});
				success(`added ${account.email} as Claude account ${account.slot}`);
				return 0;
			}
			case 'switch': {
				const providerId = parseProvider(rest[0]);
				return await seat(providerId, (await resolve(providerId, rest[1])).id, 'manual');
			}
			case 'best': {
				const providerId = parseProvider(rest[0]);
				const settings = await loadSettings();
				return await seatPicked(
					providerId,
					(state) => pickBest(state, settings.autoModelLimits),
					'best',
					'no other account has enough left to switch to',
				);
			}
			case 'rotate': {
				const providerId = parseProvider(rest[0]);
				return await seatPicked(
					providerId,
					rotateNext,
					'rotate',
					'add another account first - switching needs at least two',
				);
			}
			case 'next': {
				const providerId = parseProvider(rest[0]);
				return await seatPicked(
					providerId,
					nextAvailable,
					'next',
					'every other account is out of room',
				);
			}
			case 'disable':
			case 'enable': {
				const providerId = parseProvider(rest[0]);
				const account = await resolve(providerId, rest[1]);
				await updateRegistry((registry) => {
					const record = registry.accounts.find((entry) => entry.id === account.id);
					if (record) record.disabled = command === 'disable';
				});
				await publishState();
				success(`${account.email} is ${command}d`);
				return 0;
			}
			case 'rename': {
				const providerId = parseProvider(rest[0]);
				const account = await resolve(providerId, rest[1]);
				const name = rest[2];
				await updateRegistry((registry) =>
					setAlias(registry, account.id, name && name !== '--unset' ? name : undefined),
				);
				process.stdout.write(
					name && name !== '--unset'
						? `${account.email} is now called "${name}"\n`
						: `removed the name from ${account.email}\n`,
				);
				return 0;
			}
			case 'remove': {
				const providerId = parseProvider(rest[0]);
				const account = await resolve(providerId, rest[1]);
				const wasInUse = (await loadRegistry()).active[providerId] === account.id;
				await forgetSession(PROVIDERS[providerId], account);
				await updateRegistry((registry) => removeAccount(registry, account.id));
				await publishState();
				success(`removed ${account.email} and deleted its saved login`);
				if (wasInUse) {
					note(
						`${PROVIDERS[providerId].displayName} itself is still signed in as ${account.email}. Switch to another account to change that.`,
					);
				}
				return 0;
			}
			case 'list': {
				const registry = await loadRegistry();
				warnUnreadable(registry);
				for (const providerId of PROVIDER_IDS) {
					for (const account of accountsFor(registry, providerId)) {
						const active = registry.active[providerId] === account.id ? '*' : ' ';
						const state = account.disabled ? ' (disabled)' : '';
						process.stdout.write(
							`${active} ${providerId} ${account.slot}  ${account.alias ?? account.email}${state}\n`,
						);
					}
				}
				return 0;
			}
			case 'history': {
				const asked = Number.parseInt(flagValue(rest, '--limit') ?? '20', 10);
				const entries = await readHistory(Number.isFinite(asked) && asked > 0 ? asked : 20);
				if (rest.includes('--json')) {
					process.stdout.write(`${JSON.stringify(entries)}\n`);
					return 0;
				}
				for (const entry of entries) {
					const when = new Date(entry.at).toLocaleString();
					process.stdout.write(
						`${when}  ${entry.provider}  ${entry.from ?? '-'} → ${entry.to}  (${entry.reason})\n`,
					);
				}
				return 0;
			}
			case 'config': {
				if (rest[0] === 'set') {
					const key = rest[1];
					if (!key || !isSettingKey(key)) throw new Error(`unknown setting "${key ?? ''}"`);
					const value = rest[2];
					if (value === undefined) throw new Error(`config set ${key} needs a value`);
					await setSetting(key, value);
					await publishState();
					return await showConfig(rest.includes('--json'));
				}
				if (rest[0] === 'reset') {
					const key = rest[1];
					if (!key || !isSettingKey(key)) throw new Error(`unknown setting "${key ?? ''}"`);
					await resetSetting(key);
					await publishState();
					return await showConfig(rest.includes('--json'));
				}
				return await showConfig(rest.includes('--json'));
			}
			case 'menubar': {
				const app = await findApp();
				if (!app) {
					problem('could not find Hotseat.app - build it with: bash macos/build.sh');
					return 1;
				}
				const binary = process.execPath;
				if (rest[0] === 'stop') {
					if (!(await isRunning())) {
						note('the menu bar app was not running');
						return 0;
					}
					await stopMenuBar();
					success('closed the menu bar app');
					return 0;
				}
				if (rest[0] === 'install') {
					await stopMenuBar();
					const path = await installLoginItem(app, binary);
					success('the menu bar app will now start when you log in');
					note(path);
					return 0;
				}
				if (rest[0] === 'uninstall') {
					const existed = await removeLoginItem();
					await stopMenuBar();
					success(
						existed ? 'it will no longer start at login' : 'it was not set to start at login',
					);
					return 0;
				}
				if (rest[0] === 'status') {
					say(`running:  ${(await isRunning()) ? 'yes' : 'no'}`);
					say(`at login: ${(await loginItemInstalled()) ? 'yes' : 'no'}`);
					say(`app:      ${app}`);
					return 0;
				}
				if (await isRunning()) {
					note('the menu bar app is already running');
					return 0;
				}
				await startMenuBar(app);
				success('the menu bar app is running');
				return 0;
			}
			case 'auto': {
				if (rest.includes('--once')) {
					const reports = await autoTick();
					if (rest.includes('--json')) {
						process.stdout.write(`${JSON.stringify(reports)}\n`);
						return 0;
					}
					if (reports.length === 0)
						process.stdout.write('nothing to switch: each service needs two accounts\n');
					for (const report of reports) {
						process.stdout.write(`${PROVIDERS[report.provider].displayName}: ${report.detail}\n`);
					}
					return 0;
				}
				process.stdout.write('watching usage - press Control-C to stop\n');
				await autoLoop((line) => process.stdout.write(`${line}\n`));
				return 0;
			}
			case 'move': {
				const providerId = parseProvider(rest[0]);
				const account = await resolve(providerId, rest[1]);
				const slot = Number.parseInt(rest[2] ?? '', 10);
				if (!Number.isInteger(slot) || slot < 1) throw new Error('give a number of 1 or more');
				await moveSlot(providerId, account.id, slot);
				await publishState();
				process.stdout.write(`${account.email} is now number ${slot}\n`);
				return 0;
			}
			case 'swap': {
				const providerId = parseProvider(rest[0]);
				const first = await resolve(providerId, rest[1]);
				const second = await resolve(providerId, rest[2]);
				await swapSlots(providerId, first.id, second.id);
				await publishState();
				process.stdout.write(`${first.email} and ${second.email} traded numbers\n`);
				return 0;
			}
			case 'map': {
				if (rest.length === 0) {
					const mappings = await listMappings();
					if (mappings.length === 0) process.stdout.write('no directory rules yet\n');
					for (const mapping of mappings) {
						process.stdout.write(`${mapping.provider}  ${mapping.email}  ${mapping.path}\n`);
					}
					return 0;
				}
				const providerId = parseProvider(rest[0]);
				const account = await resolve(providerId, rest[1]);
				const path = rest[2] ?? process.cwd();
				await setMapping({
					path,
					provider: providerId,
					accountId: account.id,
					email: account.email,
				});
				process.stdout.write(`${path} will use ${account.email}\n`);
				return 0;
			}
			case 'unmap': {
				const removed = await removeMapping(rest[0] ?? process.cwd());
				process.stdout.write(
					removed > 0 ? `removed ${removed} rule(s)\n` : 'no rule was set for that directory\n',
				);
				return 0;
			}
			case 'run': {
				const providerId = parseProvider(rest[0]);
				const provider = PROVIDERS[providerId];
				const separator = rest.indexOf('--');
				const selector = separator < 0 ? rest[1] : separator > 1 ? rest[1] : undefined;
				const given = separator < 0 ? [] : rest.slice(separator + 1);
				const command = given.length > 0 ? given : [provider.session.defaultCommand];
				const account = selector
					? await resolve(providerId, selector)
					: ((await mappingFor(process.cwd(), providerId).then(async (mapping) =>
							mapping ? resolve(providerId, mapping.email) : undefined,
						)) ?? undefined);
				if (!account) {
					throw new Error(
						'no account given and no rule covers this folder - name one, or set a rule with "hotseat map"',
					);
				}
				const state = await collectState();
				const providerState = state.providers[providerId];
				// Anything said here goes to stderr: the command's own stdout may be
				// piped somewhere that expects only its output.
				const aside = (text: string): void => {
					process.stderr.write(`${text}\n`);
				};
				if (!needsSession(providerState, account.id)) {
					aside(`${account.email} is the account in use, so this runs on the shared login`);
					const plain = Bun.spawn(command, {
						stdin: 'inherit',
						stdout: 'inherit',
						stderr: 'inherit',
					});
					return await plain.exited;
				}
				const session = await prepareSession(provider, account);
				const shared = providerState.accounts.find(
					(entry) => entry.id === providerState.activeAccountId,
				);
				aside(
					`running as ${account.email} in this terminal only - every other terminal stays on ${shared?.email ?? 'the shared login'}`,
				);
				const child = Bun.spawn(command, {
					env: { ...process.env, ...session.env },
					stdin: 'inherit',
					stdout: 'inherit',
					stderr: 'inherit',
				});
				const code = await child.exited;
				if (await captureSession(provider, account)) {
					aside(`saved the login ${account.email} refreshed during this session`);
				}
				return code;
			}
			case 'export': {
				const path = rest[0];
				if (!path) throw new Error('give a file to write to');
				const count = await exportAccounts(path);
				process.stdout.write(
					`wrote ${count} account(s) to ${path}\nthis file contains live logins - keep it private and delete it when done\n`,
				);
				return 0;
			}
			case 'import': {
				const path = rest[0];
				if (!path) throw new Error('give a file to read from');
				process.stdout.write(`imported ${await importAccounts(path)} account(s)\n`);
				return 0;
			}
			case 'purge': {
				if (!rest.includes('--yes')) {
					process.stdout.write(
						'this deletes every account, saved login, setting and the history.\nyour Claude and Codex logins are not touched.\nrun "hotseat purge --yes" to go ahead\n',
					);
					return 0;
				}
				process.stdout.write(`deleted ${await purge()}\n`);
				return 0;
			}
			case 'help':
			case '--help':
			case '-h':
				process.stdout.write(renderHelp());
				return 0;
			default:
				problem(`there is no "${command}" command`);
				process.stdout.write(renderHelp());
				return 64;
		}
	} catch (error) {
		const message = (error as Error).message;
		if (message === 'cancelled') {
			say('');
			note('cancelled');
			return 130;
		}
		problem(message);
		return 1;
	}
}
