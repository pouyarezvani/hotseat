import { describe, expect, test } from 'bun:test';
import { credentialFromToken } from '../src/providers/claude/index.ts';
import { isolateAccountKeys, mergeAccountKeys, oauthOf } from '../src/providers/claude/keychain.ts';
import { keychainServiceFor } from '../src/providers/claude/login.ts';

/** What a full sign-in carries. Anything narrower cannot read its own usage. */
const FULL_SCOPES = [
	'user:profile',
	'user:inference',
	'user:sessions:claude_code',
	'user:mcp_servers',
	'user:file_upload',
];

describe('isolated sign-in', () => {
	test('a scratch directory keys a different keychain item than the everyday one', () => {
		const service = keychainServiceFor('/tmp/hotseat-claude-abc123');
		expect(service).toStartWith('Claude Code-credentials-');
		expect(service).not.toBe('Claude Code-credentials');
	});

	test('the same directory always keys the same item, so cleanup finds it', () => {
		expect(keychainServiceFor('/tmp/one')).toBe(keychainServiceFor('/tmp/one'));
		expect(keychainServiceFor('/tmp/one')).not.toBe(keychainServiceFor('/tmp/two'));
	});
});

describe('credential handling', () => {
	test('a full sign-in keeps every scope it was granted', () => {
		const live = {
			claudeAiOauth: {
				accessToken: 'a',
				refreshToken: 'r',
				expiresAt: 1,
				scopes: FULL_SCOPES,
				subscriptionType: 'max',
			},
			organizationUuid: 'org',
			mcpOAuth: { some: 'machine-wide thing' },
		};
		const saved = isolateAccountKeys(live);
		expect((saved.claudeAiOauth as { scopes: string[] }).scopes).toEqual(FULL_SCOPES);
	});

	test('saving an account never carries away the machine connector logins', () => {
		const live = {
			claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 },
			mcpOAuth: { sentry: 'token' },
			pluginSecrets: { thing: 'secret' },
		};
		const saved = isolateAccountKeys(live);
		expect(saved.mcpOAuth).toBeUndefined();
		expect(saved.pluginSecrets).toBeUndefined();
	});

	test('switching accounts leaves the machine connector logins in place', () => {
		const live = {
			claudeAiOauth: { accessToken: 'old', refreshToken: 'old-r', expiresAt: 1 },
			mcpOAuth: { sentry: 'token' },
		};
		const incoming = {
			claudeAiOauth: { accessToken: 'new', refreshToken: 'new-r', expiresAt: 2 },
		};
		const merged = mergeAccountKeys(live, incoming);
		expect(oauthOf(merged)?.accessToken).toBe('new');
		expect(merged.mcpOAuth).toEqual({ sentry: 'token' });
	});
});

describe('token fallback', () => {
	test('refuses anything that is not a Claude token', () => {
		expect(() => credentialFromToken('hello')).toThrow();
		expect(() => credentialFromToken('   ')).toThrow();
	});

	test('accepts a real token shape and marks it inference-only', () => {
		const credential = credentialFromToken('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
		expect(oauthOf(credential)?.accessToken).toStartWith('sk-ant-oat01');
		expect((credential.claudeAiOauth as { scopes: string[] }).scopes).toEqual(['user:inference']);
	});
});
