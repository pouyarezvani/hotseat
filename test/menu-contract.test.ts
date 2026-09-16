import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { coerce, isSettingKey, SETTING_KEYS } from '../src/core/settings.ts';
import { PROVIDER_IDS } from '../src/core/types.ts';

const ROOT = join(import.meta.dir, '..');

async function read(path: string): Promise<string> {
	return readFile(join(ROOT, path), 'utf8');
}

const menu = await read('macos/Sources/main.swift');
const model = await read('macos/Sources/Model.swift');
const row = await read('macos/Sources/AccountRowView.swift');
const cli = await read('src/cli.ts');

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
		const written = [...menu.matchAll(/(?:toggle|choiceItem)\([^)]*?key:\s*"([A-Za-z]+)"/gs)].map(
			(match) => match[1] as string,
		);
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
			...menu.matchAll(/choiceItem\([^)]*?key:\s*"([A-Za-z]+)",\s*value:\s*"([A-Za-z0-9-]+)"/gs),
		].map(([, key, value]) => ({ key, value }));

		const loops = [
			...menu.matchAll(/for (?:choice|value) in \[([^\]]+)\][\s\S]{0,400}?key:\s*"([A-Za-z]+)"/g),
		].flatMap(([, list, key]) =>
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

		const offered = [...literals, ...loops, ...tuples];
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

describe('the menu does not repeat the crash it already caused', () => {
	// Giving a menu item a submenu makes AppKit replace the item's action with an
	// internal one belonging to the menu. A row that invoked the item's action
	// sent that selector to an NSMenu, which does not implement it, and the app
	// died the moment an account row was clicked.
	test('no code performs a menu item action reflectively', () => {
		expect(menu).not.toContain('.perform(action');
		expect(row).not.toContain('.perform(action');
	});

	test('an account row is given its own click handler instead', () => {
		expect(menu).toContain('onClick:');
	});

	test('the row does not read the menu item to decide what a click does', () => {
		const mouseUp = row.slice(row.indexOf('override func mouseUp'));
		expect(mouseUp).toContain('onClick()');
		expect(mouseUp).not.toContain('item.action');
	});
});

describe('destructive actions ask first', () => {
	test('removing an account shows a confirmation before it runs', () => {
		const remove = menu.slice(menu.indexOf('func removeSelector'));
		const body = remove.slice(0, remove.indexOf('@objc private func toggleSetting'));
		expect(body).toContain('NSAlert');
		expect(body).toContain('alertFirstButtonReturn');
		// The command must come after the confirmation, never before it.
		expect(body.indexOf('runModal')).toBeLessThan(body.indexOf('perform(["remove"'));
	});

	test('switching and settings changes do not nag with a dialog', () => {
		const settings = menu.slice(menu.indexOf('func fillSettings'), menu.indexOf('func caption'));
		expect(settings).not.toContain('NSAlert');
	});
});

describe('the menu never holds a credential', () => {
	test('it reads no keychain and no auth file of its own', () => {
		expect(menu).not.toContain('security');
		expect(menu).not.toContain('auth.json');
		expect(menu).not.toContain('claudeAiOauth');
	});

	test('it makes no network request of its own', async () => {
		const sources = [menu, model, row, await read('macos/Sources/Runner.swift')];
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

	test('the count excludes the account already in use', () => {
		const header = menu.slice(menu.indexOf('func providerHeader'));
		const body = header.slice(0, header.indexOf('private func accountItem'));
		expect(body).toContain('activeAccountId');
		expect(body).toContain('minimumUsableHeadroom');
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

describe('every menu item explains itself on hover', () => {
	const body = menu.slice(menu.indexOf('// MARK: - Menu'));
	const optionalTip = ['caption', 'action', 'bound'];

	test.each(optionalTip)('every %s(…) item passes a tooltip', (helper) => {
		const sites = calls(body, helper).filter((site) => !site.startsWith(`${helper}(_ `));
		expect(sites.length).toBeGreaterThan(0);
		for (const site of sites) {
			expect(site).toContain('tip:');
		}
	});

	test('the helpers that always take a tooltip really assign it', () => {
		for (const helper of [
			'live',
			'toggle',
			'choiceItem',
			'submenuItem',
			'caption',
			'action',
			'bound',
		]) {
			const definition = menu.slice(menu.indexOf(`func ${helper}(`));
			const signature = definition.slice(0, definition.indexOf('{'));
			expect(signature).toContain('tip');
			const implementation = definition.slice(0, definition.indexOf('\n\t}\n'));
			expect(implementation).toMatch(/toolTip = tip|tip: tip/);
		}
	});

	test('items built by hand set a tooltip too', () => {
		for (const marker of ['func providerHeader', 'func accountItem', 'func fillHistory']) {
			const start = body.indexOf(marker);
			expect(start).toBeGreaterThan(-1);
			const section = body.slice(start, body.indexOf('\n\t}\n', start));
			expect(section).toContain('toolTip =');
		}
	});

	test('an account row shows its tooltip on the view the mouse is over', () => {
		expect(row).toContain('override var toolTip');
		expect(row).toContain('content.toolTip = toolTip');
	});

	/**
	 * Every string literal that follows `tip:` or `toolTip =`, read with a small
	 * scanner because an interpolation may itself contain quotes.
	 */
	function tooltipLiterals(): string[] {
		const found: string[] = [];
		for (const match of body.matchAll(/(?:tip:|toolTip =)\s*"/g)) {
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
			found.push(body.slice(start, index));
		}
		return found;
	}
	const tips = tooltipLiterals();

	test('there are tooltips for every kind of item', () => {
		expect(tips.length).toBeGreaterThan(30);
	});

	test.each(tips)('"%s" is a full plain-English sentence', (tip) => {
		const prose = tip.replace(/\\\([^)]*\)/g, 'X').replace(/\\u\{[0-9a-f]+\}/gi, "'");
		expect(prose.length).toBeGreaterThan(30);
		expect(prose.trim()).toMatch(/[.X]$/);
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
		for (const value of [80, 85, 90, 95, 99]) {
			expect(body).toMatch(new RegExp(`${value}: "Switch`));
		}
		for (const choice of ['"all"', '"worst"', '"none"']) {
			expect(body).toMatch(new RegExp(`\\(${choice}, "[^"]+", "[^"]{40,}"\\)`));
		}
	});
});
