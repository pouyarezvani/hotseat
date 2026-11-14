import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { coerce, isSettingKey, SETTING_KEYS } from '../src/core/settings.ts';
import { PROVIDER_IDS } from '../src/core/types.ts';

const ROOT = join(import.meta.dir, '..');

async function read(path: string): Promise<string> {
	return readFile(join(ROOT, path), 'utf8');
}

const app = await read('macos/Sources/main.swift');
const panel = await read('macos/Sources/Panel.swift');
/** Everything the menu bar app does and shows: the app itself and its dropdown. */
const menu = `${app}\n${panel}`;
const model = await read('macos/Sources/Model.swift');
const cli = await read('src/cli.ts');
const build = await read('macos/build.sh');
const loginItem = await read('macos/Sources/LoginItem.swift').catch(() => '');

/** Every command the CLI answers to, taken from its own dispatch. */
const commands = new Set(
	[...cli.matchAll(/^\t{3}case '([a-z-]+)':/gm)].map((match) => match[1] as string),
);

/** Every CLI invocation the menu makes, as the command it puts first. */
function menuInvocations(): { command: string; args: string[] }[] {
	const found: { command: string; args: string[] }[] = [];
	for (const match of menu.matchAll(
		/(?:perform|runner\.run|decode\([A-Za-z]+\.self,)\s*\(?\[([^\]]+)\]/g,
	)) {
		const parts = (match[1] ?? '')
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		const first = parts[0];
		if (!first?.startsWith('"')) continue;
		found.push({ command: first.replace(/"/g, ''), args: parts.slice(1) });
	}
	return found;
}

describe('the menu only asks for commands the CLI has', () => {
	const invocations = menuInvocations();

	test('the menu actually invokes the CLI', () => {
		expect(invocations.length).toBeGreaterThan(5);
	});

	test.each(invocations.map((entry) => entry.command))('"%s" is a real command', (command) => {
		expect(commands.has(command)).toBe(true);
	});

	test('every settings key the menu writes is a real setting', () => {
		// Only the two helpers that change a setting. A keyboard shortcut uses a
		// `key:` label too, and is not a setting.
		const written = [
			...panel.matchAll(/(?:ToggleRow|ChoiceChip)\([^)]*?key:\s*"([A-Za-z]+)"/gs),
		].map((match) => match[1] as string);
		expect(written.length).toBeGreaterThan(3);
		for (const key of written) {
			expect(SETTING_KEYS as string[]).toContain(key);
		}
	});

	test('every settings value the menu offers is one the CLI will accept', () => {
		// Values reach choiceItem both as literals and from the loops just above
		// it, so both are checked. This is what catches a menu offering a choice
		// the CLI would reject, such as a threshold past its ceiling.
		const literals = [
			...panel.matchAll(/ChoiceChip\([^)]*?key:\s*"([A-Za-z]+)",\s*value:\s*"([A-Za-z0-9-]+)"/gs),
		].map(([, key, value]) => ({ key, value }));

		const choices = /thresholdChoices: \[Int\] = \[([^\]]+)\] \+ Array\((\d+)\.\.\.(\d+)\)/.exec(
			menu,
		);
		const thresholds = choices
			? [
					...(choices[1] ?? '').split(',').map((part) => Number(part.trim())),
					...Array.from(
						{ length: Number(choices[3]) - Number(choices[2]) + 1 },
						(_, i) => Number(choices[2]) + i,
					),
				].map((value) => ({ key: 'autoThresholdPercent', value: String(value) }))
			: [];

		const loops = [
			...thresholds,
			...menu.matchAll(/for (?:choice|value) in \[([^\]]+)\][\s\S]{0,400}?key:\s*"([A-Za-z]+)"/g),
		]
			.flatMap((entry) => (Array.isArray(entry) ? [entry] : []))
			.flatMap(([, list, key]) =>
				(list ?? '')
					.split(',')
					.map((part) => part.trim().replace(/"/g, ''))
					.filter((part) => part.length > 0)
					.map((value) => ({ key, value })),
			);

		const tupleBlock = menu.slice(menu.indexOf('percentageChoices: [(String, String, String)]'));
		const tuples = [
			...tupleBlock.slice(0, tupleBlock.indexOf(']\n')).matchAll(/\("([a-z]+)", "/g),
		].map(([, value]) => ({ key: 'titlePercentage', value }));

		const offered = [...literals, ...loops, ...tuples, ...thresholds];
		expect(offered.length).toBeGreaterThan(5);
		for (const { key, value } of offered) {
			if (!key || !value || !isSettingKey(key)) continue;
			expect(() => coerce(key, value)).not.toThrow();
		}
	});

	test('every service the menu names is a real service', () => {
		const named = [...model.matchAll(/providerOrder = \[([^\]]+)\]/g)]
			.flatMap((match) => (match[1] ?? '').split(','))
			.map((part) => part.trim().replace(/"/g, ''))
			.filter((part) => part.length > 0);
		expect(named.length).toBe(PROVIDER_IDS.length);
		for (const service of named) expect(PROVIDER_IDS as readonly string[]).toContain(service);
	});
});

describe("the dropdown is the app's own window, not a system menu", () => {
	test('the menu bar button opens the dropdown itself', () => {
		expect(app).toContain('statusItem.button?.action = #selector(toggleDropdown)');
		expect(app).not.toContain('statusItem.menu');
		expect(menu).not.toContain('NSMenuItem');
	});

	test('a click anywhere else closes it, and so does Escape', () => {
		expect(panel).toContain('addGlobalMonitorForEvents');
		expect(panel).toContain('addLocalMonitorForEvents');
		expect(panel).toContain('override func cancelOperation');
	});

	test('it follows its content, and scrolls only once it would run off the screen', () => {
		expect(panel).toContain('hosting.fittingSize');
		expect(panel).toContain('.frame(height: min(max(height, 1), maxHeight))');
	});

	test('a dialog never opens underneath it', () => {
		for (const marker of [
			'private func remove(provider',
			'private func addFromToken',
			'private func report(failure',
		]) {
			const start = app.indexOf(marker);
			expect(start).toBeGreaterThan(-1);
			const body = app.slice(start, app.indexOf('\n\t}\n', start));
			expect(body.indexOf('dropdown.close()')).toBeGreaterThan(-1);
			expect(body.indexOf('dropdown.close()')).toBeLessThan(body.indexOf('NSAlert()'));
		}
	});
});

describe('destructive actions ask first', () => {
	test('removing an account shows a confirmation before it runs', () => {
		const remove = app.slice(app.indexOf('private func remove(provider'));
		const body = remove.slice(0, remove.indexOf('private func changeSetting'));
		expect(body).toContain('NSAlert');
		expect(body).toContain('alertFirstButtonReturn');
		// The command must come after the confirmation, never before it.
		expect(body.indexOf('runModal')).toBeLessThan(body.indexOf('perform(["remove"'));
	});

	test('switching and settings changes do not nag with a dialog', () => {
		for (const marker of ['private func seat(', 'private func changeSetting(']) {
			const start = app.indexOf(marker);
			expect(start).toBeGreaterThan(-1);
			expect(app.slice(start, app.indexOf('\n\t}\n', start))).not.toContain('NSAlert');
		}
		expect(panel).not.toContain('NSAlert');
	});
});

describe('the menu never holds a credential', () => {
	test('it reads no keychain and no auth file of its own', () => {
		expect(menu).not.toContain('security');
		expect(menu).not.toContain('auth.json');
		expect(menu).not.toContain('claudeAiOauth');
	});

	test('it makes no network request of its own', async () => {
		const sources = [menu, model, await read('macos/Sources/Runner.swift')];
		for (const source of sources) {
			expect(source).not.toContain('URLSession');
			expect(source).not.toContain('https://');
		}
	});
});

describe('the menu shows the app icon', () => {
	test('the bundle declares an icon file', async () => {
		const build = await read('macos/build.sh');
		expect(build).toContain('CFBundleIconFile');
		expect(build).toContain('Hotseat.icns');
	});

	test('the icon is drawn from source rather than checked in as an opaque blob', async () => {
		const generator = await read('macos/Icon/MakeIcon.swift');
		expect(generator).toContain('icon_512x512@2x');
		expect(generator).toContain('icon_16x16');
	});
});

describe('the ready count agrees with what switching would do', () => {
	test('the menu uses the same minimum headroom as the switcher', async () => {
		const { MIN_USABLE_HEADROOM } = await import('../src/core/switch.ts');
		const declared = /minimumUsableHeadroom: Double = (\d+)/.exec(model)?.[1];
		expect(Number(declared)).toBe(MIN_USABLE_HEADROOM);
	});

	const count = model.slice(model.indexOf('func switchableCount'));
	const body = count.slice(0, count.indexOf('\n\t}\n'));

	test('the count excludes the account already in use', () => {
		expect(body).toContain('account.id != activeAccountId');
		expect(body).toContain('minimumUsableHeadroom');
		expect(panel).toContain('switchableCount(countingModels: board.settings.autoModelLimits)');
	});
	test('the count leaves out an account whose login the service refused, as the switcher does', () => {
		expect(body).toContain('account.usage?.errorKind != "auth"');
		expect(model).toMatch(/var errorKind: String\?/);
	});
});

/**
 * Returns every call of `name(` in the source with its balanced argument text,
 * so a call whose arguments span lines and nest parentheses is read whole.
 */
function calls(source: string, name: string): string[] {
	const found: string[] = [];
	const needle = `${name}(`;
	let from = 0;
	for (;;) {
		const start = source.indexOf(needle, from);
		if (start < 0) return found;
		const before = source[start - 1] ?? ' ';
		if (/[A-Za-z0-9_.]/.test(before) && before !== '.') {
			from = start + needle.length;
			continue;
		}
		let depth = 0;
		let index = start + needle.length - 1;
		for (; index < source.length; index += 1) {
			const char = source[index];
			if (char === '(') depth += 1;
			if (char === ')') depth -= 1;
			if (depth === 0) break;
		}
		found.push(source.slice(start, index + 1));
		from = index + 1;
	}
}

describe('everything in the dropdown explains itself on hover', () => {
	const body = panel;
	const controls = ['ActionButton', 'ToggleRow', 'ChoiceChip', 'SectionLabel'];

	test.each(controls)('every %s(…) is given a tooltip', (control) => {
		const sites = calls(body, control);
		expect(sites.length).toBeGreaterThan(0);
		for (const site of sites) {
			expect(site).toContain('tip:');
		}
	});

	test.each(controls)('%s cannot be made without a tooltip, and shows it', (control) => {
		const definition = body.slice(body.indexOf(`struct ${control}: View`));
		const implementation = definition.slice(0, definition.indexOf('\n}\n'));
		expect(implementation).toMatch(/\n\tlet tip: String\n/);
		expect(implementation).toContain('.help(tip)');
	});

	test('the parts built by hand show a tooltip too', () => {
		for (const marker of [
			'struct AccountCard: View',
			'struct AccountsPage: View',
			'struct HistoryPage: View',
			'struct AddPage: View',
		]) {
			const start = body.indexOf(marker);
			expect(start).toBeGreaterThan(-1);
			expect(body.slice(start, body.indexOf('\n}\n', start))).toContain('.help(');
		}
	});

	/**
	 * Every string literal that follows `tip:` or opens a `.help(`, read with a
	 * small scanner because an interpolation may itself contain quotes.
	 */
	function tooltipLiterals(): string[] {
		const found: string[] = [];
		for (const match of body.matchAll(/(?:tip:|\.help\(|return)\s*"/g)) {
			let depth = 0;
			let index = (match.index ?? 0) + match[0].length;
			const start = index;
			for (; index < body.length; index += 1) {
				const char = body[index];
				if (char === '\\') {
					if (body[index + 1] === '(') depth += 1;
					index += 1;
					continue;
				}
				if (depth > 0 && char === ')') depth -= 1;
				else if (depth === 0 && char === '"') break;
			}
			const literal = body.slice(start, index);
			// A `return` of a short word is a label or a reason, not a tooltip.
			if (match[0].startsWith('return') && literal.length < 60) continue;
			found.push(literal);
		}
		return found;
	}
	const tips = tooltipLiterals();

	test('there are tooltips for every kind of control', () => {
		expect(tips.length).toBeGreaterThan(30);
	});

	test.each(tips)('"%s" is a full plain-English sentence', (tip) => {
		const prose = tip.replace(/\\\([^)]*\)/g, 'X').replace(/\\u\{[0-9a-f]+\}/gi, "'");
		expect(prose.length).toBeGreaterThan(30);
		expect(prose.trim()).toMatch(/[.X]$|[.X] $/);
		const words = prose.toLowerCase().replace(/hotseat/g, '');
		for (const jargon of [
			'bench',
			'seat',
			'rotation',
			'headroom',
			'provider',
			'ready',
			'hysteresis',
		]) {
			expect(words).not.toMatch(new RegExp(`\\b${jargon}\\b`));
		}
	});

	test('every threshold choice and every title choice has its own tooltip', () => {
		expect(body).toContain('thresholdChoices: [Int] = [80, 85] + Array(90...99)');
		for (const value of [80, 85, 90, 99]) {
			expect(body).toMatch(new RegExp(`case ${value}:\\s*\\n\\s*return "Switch`));
		}
		expect(body).toContain('leaving \\(left)% for the turn in progress');
		for (const choice of ['"all"', '"worst"', '"none"']) {
			expect(body).toMatch(new RegExp(`\\(${choice}, "[^"]+", "[^"]{40,}"\\)`));
		}
	});
});

describe('which services sit in the menu bar', () => {
	test('is chosen in the dropdown, and the choice is a real setting', () => {
		expect(panel).toContain('key: "titleProviders"');
		expect(SETTING_KEYS as string[]).toContain('titleProviders');
	});

	test('the last one left cannot be taken out, and says why', () => {
		expect(panel).toContain('let last = isOn && visible.count <= 1');
		expect(panel).toContain('locked: last');
		expect(panel).toContain('one has to stay');
	});

	test('the title leaves out a service that was not chosen, the way the command line does', () => {
		expect(model).toContain('where settings.titleProviders.contains(entry.id)');
		expect(model).toContain('var titleProviders: [String] = ["claude", "codex"]');
	});

	test('every service is switched the same way: none is only shown', () => {
		expect(model).not.toContain('displayOnly');
		expect(menu).not.toContain('displayOnly');
		expect(panel).toContain('private var canSwitch: Bool { !isActive && !account.disabled }');
	});
});

describe('the files the menu opens for editing', () => {
	test('are the two files hotseat documents as editable, under the hotseat folder', () => {
		expect(menu).toContain('openInEditor("accounts.json"');
		expect(menu).toContain('openInEditor("settings.json"');
		const readme = menu.includes('Self.homePath');
		expect(readme).toBe(true);
	});

	test('the compact title uses a mark for every service the CLI knows', () => {
		const logo = require('node:fs').readFileSync(
			join(ROOT, 'macos/Sources/Logo.swift'),
			'utf8',
		) as string;
		for (const id of PROVIDER_IDS) {
			expect(logo).toContain(`case "${id}": return "`);
		}
		for (const file of [
			'claude.svg',
			'openai.svg',
			'antigravity.svg',
			'antigravity-color.png',
			'grok.svg',
		]) {
			expect(require('node:fs').existsSync(join(ROOT, 'macos/Logos', file))).toBe(true);
		}
	});
});

describe('the menu bar does not refresh off its own writes', () => {
	test('the folder watcher reloads only when the published board changed', () => {
		const watcher = menu.slice(
			menu.indexOf('private func watchState'),
			menu.indexOf('private func stopWatching'),
		);
		expect(watcher).toContain('publishedStamp()');
		expect(watcher).toContain('guard stamp != self.lastPublished else { return }');
		expect(menu).toContain('appendingPathComponent("state.json")');
	});
});

describe('the menu bar hears what the automatic pass did', () => {
	test('it asks for the pass as JSON, and the CLI answers in JSON', () => {
		expect(menu).toContain('["auto", "--once", "--json"]');
		const auto = cli.slice(cli.indexOf("case 'auto'"), cli.indexOf("case 'move'"));
		expect(auto).toContain("rest.includes('--json')");
		expect(auto).toContain('JSON.stringify(reports)');
	});
});

describe('the menu bar rests while the Mac sleeps', () => {
	test('its passes stop when the Mac goes to sleep and start again only on a full wake', () => {
		expect(menu).toContain('NSWorkspace.willSleepNotification');
		expect(menu).toContain('NSWorkspace.didWakeNotification');
		const sleep = menu.slice(menu.indexOf('@objc private func willSleep'));
		expect(sleep.slice(0, sleep.indexOf('\n\t}\n'))).toContain('timer?.invalidate()');
		const wake = menu.slice(menu.indexOf('@objc private func didWake'));
		const body = wake.slice(0, wake.indexOf('\n\t}\n'));
		expect(body).toContain('isAsleep = false');
		expect(body).toContain('refresh()');
	});

	test('no pass starts while it is asleep, even one already scheduled', () => {
		const refresh = menu.slice(menu.indexOf('@objc private func refresh()'));
		expect(refresh.slice(0, refresh.indexOf('\n\t}\n'))).toContain('guard !isBusy, !isAsleep');
	});
});

describe('starting at login belongs to the app', () => {
	test('the app carries its own launch agent, so macOS shows it with the app name and icon', () => {
		expect(build).toContain('Contents/Library/LaunchAgents');
		expect(build).toContain('dev.hotseat.login.plist');
		expect(build).toContain('<key>BundleProgram</key><string>Contents/MacOS/Hotseat</string>');
		expect(build).toContain('<key>Label</key><string>dev.hotseat.login</string>');
		expect(build).toContain('"$here/Sources/LoginItem.swift"');
	});

	test('the app registers that agent itself, before it starts any interface', () => {
		expect(loginItem).toContain('SMAppService.agent(plistName: "dev.hotseat.login.plist")');
		const entry = menu.slice(menu.indexOf('let app = NSApplication.shared'));
		const before = menu.slice(0, menu.indexOf('let app = NSApplication.shared'));
		expect(before).toContain('"--login-item"');
		expect(entry).not.toContain('"--login-item"');
	});
});

describe('the app keeps its login item working', () => {
	test('turning it on waits for the old registration to finish stopping before registering again', () => {
		expect(loginItem).toContain('service.unregister { error in');
		const on = loginItem.slice(loginItem.indexOf('case "on":'), loginItem.indexOf('case "off":'));
		expect(on.indexOf('waitFor')).toBeGreaterThan(-1);
		expect(on.indexOf('waitFor')).toBeLessThan(on.indexOf('try service.register()'));
	});

	test('a login item turned off in System Settings is reported as needing approval, not as a failure', () => {
		expect(loginItem).toContain('kSMErrorLaunchDeniedByUser');
		expect(loginItem).toContain('service.status == .requiresApproval');
	});

	test('a rebuild registers again only when it was already on', () => {
		const after = build.slice(build.indexOf('mv "$app" "$final_app"'));
		expect(after).toContain('--login-item status');
		expect(after).toMatch(/= "enabled" \]; then[\s\S]*--login-item on/);
	});
});

describe('signing the app', () => {
	test('a build signs with an Apple Development certificate when this Mac has one, so login items survive rebuilds', () => {
		expect(build).toContain('security find-identity -v -p codesigning');
		expect(build).toContain('Apple Development');
		expect(build).toContain('codesign --force --sign "$identity" "$app"');
	});

	test('without one it still builds, signed ad hoc, and says what that costs', () => {
		expect(build).toContain('identity="-"');
		expect(build).toContain('starting at login stops working after each rebuild');
	});
});

describe('the menu acts on the account it showed', () => {
	test('names an account by its id alone, which neither renumbering nor a name can move to another account', () => {
		expect(app).toContain('perform(["switch", provider, "id:\\(account.id)"])');
		expect(app).toContain('perform(["remove", provider, "id:\\(account.id)"])');
		expect(app).toContain(
			'perform([enabled ? "enable" : "disable", provider, "id:\\(account.id)"])',
		);
		expect(app).toContain('let selector = "id:\\(account.id)"');
		expect(app).not.toContain('account.slot');
		expect(app).not.toContain('account.email]');
	});

	test('a turned-off account can still be switched to from its menu, as its tooltip says', () => {
		const body = panel.slice(panel.indexOf('private var options: some View'));
		const before = body.slice(0, body.indexOf('"Switch to this account"'));
		expect(before).toContain('if !isActive {');
		expect(before).not.toContain('!account.disabled {');
	});

	test('Switch now waits its turn like any other action, and says when it fails', () => {
		const body = app.slice(app.indexOf('func switchToBest'), app.indexOf('func addFromToken'));
		expect(body).toContain('perform(["best"');
		expect(body).not.toContain('runner.run');
		expect(body).not.toContain('isBusy');
		// Any enabled account besides the one in use is somewhere to go, even
		// when the one in use is itself turned off.
		expect(body).toContain('!$0.disabled && $0.id != entry.state.activeAccountId');
	});

	test('opening History or Settings never waits on the command line', () => {
		expect(panel).not.toContain('runner.');
		expect(panel).not.toContain('Runner(');
		expect(app).toContain('didSet { model.history = history }');
		expect(app).toContain('didSet { model.board = board }');
	});
});

describe('the History menu', () => {
	test('is read again whenever the history file changes, and a failed read is tried again', () => {
		const refresh = menu.slice(menu.indexOf('@objc private func refresh()'));
		const body = refresh.slice(0, refresh.indexOf('\n\t}\n'));
		expect(body).toContain('historyFileStamp()');
		expect(body).toContain('if let history {');
		expect(menu).toContain('"logs"');
		expect(menu).not.toContain('"history.jsonl"');
	});
});

describe('a sign-in that runs out of time', () => {
	test('is not said to have changed nothing, since the login may already have been saved', () => {
		const start = menu.indexOf('private func signIn(provider');
		const body = menu.slice(start, menu.indexOf('\n\t}\n', start));
		expect(body).not.toContain('nothing changed');
		expect(body).toContain('may have');
	});
});

describe('changing a setting from the menu', () => {
	test('shows the new value at once, before the command line answers', () => {
		const start = menu.indexOf('private func changeSetting');
		const body = menu.slice(start, menu.indexOf('\n\t}\n', start));
		expect(body).toContain('withSetting(');
		expect(body.indexOf('withSetting(')).toBeLessThan(body.indexOf('perform('));
	});
});

describe('a settings change made while a refresh is running', () => {
	test('stays on screen until its own write has finished, whatever that refresh loads', () => {
		const toggle = menu.slice(menu.indexOf('private func changeSetting'));
		expect(toggle.slice(0, toggle.indexOf('\n\t}\n'))).toContain('pendingSettings.append(');
		const refresh = menu.slice(menu.indexOf('@objc private func refresh()'));
		expect(refresh.slice(0, refresh.indexOf('\n\t}\n'))).toContain('pendingSettings.reduce(');
		const perform = menu.slice(menu.indexOf('private func perform('));
		expect(perform.slice(0, perform.indexOf('\n\t}\n'))).toContain('pendingSettings.remove(at:');
	});
});

describe("removing a service's last account", () => {
	test('stops looking for the service before the account is gone, under the lock looking takes', () => {
		const start = cli.indexOf("case 'remove': {");
		const body = cli.slice(start, cli.indexOf("case 'list': {", start));
		const lock = body.indexOf('holdSwitch(providerId)');
		const optOut = body.indexOf('setDetected(providerId, false)');
		const removed = body.indexOf('removeAccount(registry, account.id)');
		const release = body.indexOf('held.release()');
		expect(lock).toBeGreaterThan(-1);
		expect(optOut).toBeGreaterThan(lock);
		expect(removed).toBeGreaterThan(optOut);
		expect(release).toBeGreaterThan(removed);
	});
});

describe('a switch asked for by the person', () => {
	test('is marked as theirs, so it may move back to an account an open session still holds', () => {
		const seat = cli.slice(
			cli.indexOf('async function seat('),
			cli.indexOf('async function seatPicked('),
		);
		expect(seat).toContain('activate(providerId, accountId, { manual: true })');
	});
});

describe('a switch made from the command line', () => {
	test('is remembered before its history line is written, so a failed history write cannot hide it', () => {
		const seat = cli.slice(
			cli.indexOf('async function seat('),
			cli.indexOf('async function seatPicked('),
		);
		expect(seat.indexOf('rememberManualSwitch(')).toBeGreaterThan(-1);
		expect(seat.indexOf('rememberManualSwitch(')).toBeLessThan(seat.indexOf('recordSwitch('));
	});
});
