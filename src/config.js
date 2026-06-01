/**
 * config.js
 * Loads and merges configuration from multiple sources:
 *   1. .automaitrc.json (or any cosmiconfig-compatible format) in the project root
 *   2. Environment variables (AUTOMAIT_*)
 *   3. CLI flags (highest priority, applied in cli.js)
 */

import { cosmiconfig } from "cosmiconfig";

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULTS = {
	ollamaEndpoint: "http://localhost:11434",
	model: "gemma4",
	timeoutMs: 120_000,
	systemPrompt: `You are an expert software engineer that writes perfect Git commit messages.
Write a short, concise commit message following these rules:
1. Adhere strictly to the Conventional Commits specification.
2. Output ONLY the raw commit text. Do NOT wrap the response in markdown code blocks (e.g., no \`\`\`), and do not include any introductory or concluding conversational text.
3. Allowed types: feat, fix, chore, docs, refactor, test, build.
4. Scope is optional but preferred (e.g., the main module or modified package).
5. Subject must be ≤ 60 characters, lower-case, and written in the imperative mood (e.g., 'add user auth' instead of 'added user auth').`,
};

// ─── Config file schema ───────────────────────────────────────────────────────

/**
 * Loads the nearest .automaitrc.json / automait.config.js / "automait" key in package.json.
 * Returns an empty object if no config file is found.
 * @returns {Promise<Record<string, unknown>>}
 */
async function loadFileConfig() {
	const explorer = cosmiconfig("automait", {
		searchPlaces: [
			".automaitrc",
			".automaitrc.json",
			".automaitrc.js",
			"automait.config.js",
			"package.json",
		],
	});

	try {
		const result = await explorer.search();
		return result?.config ?? {};
	} catch {
		// Config file errors are non-fatal; fall back to defaults
		return {};
	}
}

// ─── Env variable mapping ─────────────────────────────────────────────────────

function loadEnvConfig() {
	const env = {};
	if (process.env.AUTOMAIT_ENDPOINT)
		env.ollamaEndpoint = process.env.AUTOMAIT_ENDPOINT;
	if (process.env.AUTOMAIT_MODEL) env.model = process.env.AUTOMAIT_MODEL;
	if (process.env.AUTOMAIT_SYSTEM_PROMPT)
		env.systemPrompt = process.env.AUTOMAIT_SYSTEM_PROMPT;
	if (process.env.AUTOMAIT_TIMEOUT_MS)
		env.timeoutMs = Number(process.env.AUTOMAIT_TIMEOUT_MS);
	return env;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds the final merged config object.
 * Priority: CLI flags > env vars > config file > defaults.
 *
 * @param {Record<string, unknown>} cliFlags - Parsed flags from commander.
 * @returns {Promise<Config>}
 */
export async function resolveConfig(cliFlags = {}) {
	const fileConfig = await loadFileConfig();
	const envConfig = loadEnvConfig();

	// Merge in ascending priority order (later keys win)
	const merged = {
		...DEFAULTS,
		...fileConfig,
		...envConfig,
		// Only spread CLI flags that were explicitly provided (not undefined)
		...(cliFlags.endpoint && { ollamaEndpoint: cliFlags.endpoint }),
		...(cliFlags.model && { model: cliFlags.model }),
		...(cliFlags.systemPrompt && { systemPrompt: cliFlags.systemPrompt }),
	};

	return merged;
}

/**
 * @typedef {Object} Config
 * @property {string} ollamaEndpoint   - Full base URL of the Ollama server.
 * @property {string} model            - Ollama model identifier.
 * @property {string} systemPrompt     - System prompt injected for commit generation.
 * @property {number} timeoutMs        - HTTP request timeout in milliseconds.
 */
