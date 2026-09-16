import { join, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './fs.ts';
import { hotseatHome } from './paths.ts';
import type { ProviderId } from './types.ts';

export interface Mapping {
	path: string;
	provider: ProviderId;
	accountId: string;
	email: string;
}

interface MappingFile {
	version: 1;
	mappings: Mapping[];
}

function mappingsPath(): string {
	return join(hotseatHome(), 'mappings.json');
}

async function load(): Promise<MappingFile> {
	return (await readJson<MappingFile>(mappingsPath())) ?? { version: 1, mappings: [] };
}

export async function listMappings(): Promise<Mapping[]> {
	return (await load()).mappings;
}

export async function setMapping(entry: Mapping): Promise<void> {
	const file = await load();
	const path = resolve(entry.path);
	file.mappings = file.mappings.filter(
		(mapping) => !(mapping.path === path && mapping.provider === entry.provider),
	);
	file.mappings.push({ ...entry, path });
	await writeJsonAtomic(mappingsPath(), file);
}

export async function removeMapping(path: string, provider?: ProviderId): Promise<number> {
	const file = await load();
	const target = resolve(path);
	const before = file.mappings.length;
	file.mappings = file.mappings.filter(
		(mapping) => !(mapping.path === target && (!provider || mapping.provider === provider)),
	);
	await writeJsonAtomic(mappingsPath(), file);
	return before - file.mappings.length;
}

/**
 * Finds the mapping for a directory, walking up to the nearest mapped parent so
 * a rule set on a project root covers everything inside it.
 */
export async function mappingFor(path: string, provider: ProviderId): Promise<Mapping | undefined> {
	const mappings = (await load()).mappings.filter((mapping) => mapping.provider === provider);
	let current = resolve(path);
	for (;;) {
		const match = mappings.find((mapping) => mapping.path === current);
		if (match) return match;
		const parent = resolve(current, '..');
		if (parent === current) return undefined;
		current = parent;
	}
}
