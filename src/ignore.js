/**
 * ignore.js
 * Helpers for reading and extending .gitignore.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function readGitignore(cwd = process.cwd()) {
	try {
		return await readFile(join(cwd, ".gitignore"), "utf8");
	} catch {
		return "";
	}
}

/**
 * @param {string[]} patterns
 * @param {string} [cwd]
 * @returns {Promise<string[]>}
 */
export async function appendGitignorePatterns(patterns, cwd = process.cwd()) {
	const existing = await readGitignore(cwd);
	const existingPatterns = new Set(
		existing
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#")),
	);

	const additions = [...new Set(patterns)]
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern && !existingPatterns.has(pattern));

	if (!additions.length) return [];

	const prefix = existing.trimEnd() ? `${existing.trimEnd()}\n\n` : "";
	const next = `${prefix}# Added by automit\n${additions.join("\n")}\n`;
	await writeFile(join(cwd, ".gitignore"), next, "utf8");

	return additions;
}
