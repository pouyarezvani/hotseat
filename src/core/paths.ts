import { homedir } from 'node:os';
import { join } from 'node:path';

export function hotseatHome(): string {
	const override = process.env.HOTSEAT_HOME;
	return override && override.length > 0 ? override : join(homedir(), '.hotseat');
}

export function registryPath(): string {
	return join(hotseatHome(), 'accounts.json');
}

export function statePath(): string {
	return join(hotseatHome(), 'state.json');
}

export function settingsPath(): string {
	return join(hotseatHome(), 'settings.json');
}

export function usageCachePath(): string {
	return join(hotseatHome(), 'usage.json');
}

export function vaultDir(): string {
	return join(hotseatHome(), 'vault');
}

export function lockPath(): string {
	return join(hotseatHome(), 'lock');
}

export function logDir(): string {
	return join(hotseatHome(), 'logs');
}
