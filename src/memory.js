/**
 * memory.js
 * Reads and writes the compact per-project automait memory.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MEMORY_PATH = join(".agents", ".automait");
const MAX_MEMORY_CHARS = 1800;

/**
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function readProjectMemory(cwd = process.cwd()) {
	try {
		const content = await readFile(join(cwd, MEMORY_PATH), "utf8");
		return content.trim().slice(0, MAX_MEMORY_CHARS);
	} catch {
		return "";
	}
}

/**
 * @param {string} content
 * @param {string} [cwd]
 */
export async function writeProjectMemory(content, cwd = process.cwd()) {
	const trimmed = content.trim().slice(0, MAX_MEMORY_CHARS);
	if (!trimmed) return;

	const fullPath = join(cwd, MEMORY_PATH);
	await mkdir(dirname(fullPath), { recursive: true });
	await writeFile(fullPath, `${trimmed}\n`, "utf8");
}

/**
 * @param {string} [cwd]
 * @returns {Promise<string[]>}
 */
export async function getProjectFolderIndex(cwd = process.cwd()) {
	const ignored = new Set([
		".git",
		".idea",
		".vscode",
		"node_modules",
		"vendor",
		"vendors",
		"dist",
		"build",
		"coverage",
	]);

	try {
		const entries = await readdir(cwd, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => !ignored.has(name))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 50);
	} catch {
		return [];
	}
}

export { MEMORY_PATH };
