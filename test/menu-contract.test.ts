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

		const offered = [...literals, ...loops];
		expect(offered.length).toBeGreaterThan(8);
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
