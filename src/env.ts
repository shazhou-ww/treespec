/**
 * treespec — .env loading and $VAR / ${VAR} substitution
 */

import { readFile } from 'node:fs/promises';

/**
 * Parse dotenv-style content into a key-value map.
 * Ignores blank lines and `#` comments. Supports optional `export` prefix
 * and single/double-quoted values.
 */
export function parseEnvContent(content: string): Record<string, string> {
	const result: Record<string, string> = {};

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		const withoutExport = line.startsWith('export ')
			? line.slice('export '.length).trim()
			: line;

		const eq = withoutExport.indexOf('=');
		if (eq <= 0) continue;

		const key = withoutExport.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

		let value = withoutExport.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		result[key] = value;
	}

	return result;
}

/**
 * Load a `.env` file. Missing file → empty object (caller decides whether that's an error).
 */
export async function loadEnvFile(path: string): Promise<Record<string, string>> {
	try {
		const content = await readFile(path, 'utf8');
		return parseEnvContent(content);
	} catch (err) {
		const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
		if (code === 'ENOENT') {
			return {};
		}
		throw err;
	}
}

/**
 * Merge file env with shell env. Only keys present in fileEnv are included;
 * shell values take priority when set. This prevents host environment
 * variables (PATH, HOME, etc.) from leaking into containers.
 */
export function mergeEnv(
	fileEnv: Record<string, string>,
	shellEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, fileValue] of Object.entries(fileEnv)) {
		result[key] = shellEnv[key] !== undefined ? shellEnv[key]! : fileValue;
	}
	return result;
}

/**
 * Replace `$VAR` and `${VAR}` in a string using `env`.
 * Unknown variables are left unchanged.
 */
export function substituteVars(input: string, env: Record<string, string>): string {
	return input.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(match, braced: string | undefined, bare: string | undefined) => {
			const name = braced ?? bare;
			if (!name) return match;
			return Object.prototype.hasOwnProperty.call(env, name) ? env[name]! : match;
		},
	);
}
