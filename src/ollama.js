/**
 * ollama.js
 * Thin client around the Ollama REST API (/api/chat) plus the iterative
 * staged-diff planner used by automait.
 */

/**
 * @typedef {Object} OllamaMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

const MAX_SCHEDULER_FILES = 3;
const MAX_ITERATIONS_FACTOR = 3;

const AUTO_DESCRIBED_FILES = new Map([
	["package-lock.json", { label: "package-lock.json" }],
	["npm-shrinkwrap.json", { label: "npm-shrinkwrap.json" }],
	["yarn.lock", { label: "yarn.lock" }],
	["pnpm-lock.yaml", { label: "pnpm-lock.yaml" }],
]);

function normalizeGitPath(filePath) {
	return filePath.replace(/\\/g, "/");
}

function basename(filePath) {
	const normalized = normalizeGitPath(filePath);
	return normalized.split("/").pop() || normalized;
}

function clampCommitTarget(target, fileCount) {
	if (!Number.isInteger(target) || target < 1 || fileCount < 1) return null;
	return Math.min(target, fileCount);
}

function commitMessageForFile(file, fallbackMessage) {
	const shortName = basename(file).replace(/\.[^.]+$/, "");
	const subject = `update ${shortName}`.slice(0, 46).trim();
	const prefixMatch = fallbackMessage.match(/^([a-z]+(?:\([^)]+\))?):/);
	const prefix = prefixMatch?.[1] || "chore(staged)";
	return `${prefix}: ${subject}`;
}

function getAutoDescription(file) {
	const metadata = AUTO_DESCRIBED_FILES.get(basename(file.path));
	if (!metadata) return null;

	const verb = file.status === "A" ? "generate" : "update";

	return {
		message: `chore: ${verb} ${metadata.label}`,
		rationale: `${metadata.label} is generated dependency metadata, so automait uses a deterministic message instead of analyzing its diff.`,
	};
}

function partitionAutoDescribedFiles(fileIndex) {
	const analyzed = [];
	const autoDescribed = [];

	for (const file of fileIndex) {
		const description = getAutoDescription(file);
		if (description) {
			autoDescribed.push({ ...file, autoDescription: description });
		} else {
			analyzed.push(file);
		}
	}

	return { analyzed, autoDescribed };
}

function buildAutoDescribedCommits(files) {
	return files.map((file, index) => ({
		id: index + 1,
		message: file.autoDescription.message,
		files: [file.path],
		rationale: file.autoDescription.rationale,
	}));
}

function mergeCommitPlans(aiPlan, autoCommits) {
	if (!autoCommits.length) return aiPlan;

	const commits = [...aiPlan.commits, ...autoCommits].map((commit, index) => ({
		...commit,
		id: index + 1,
	}));

	const generatedSummary = `${autoCommits.length} generated dependency file(s) handled with deterministic commit messages.`;

	return {
		...aiPlan,
		summary: aiPlan.summary
			? `${aiPlan.summary} ${generatedSummary}`
			: generatedSummary,
		commits,
		reasoningTrace: [
			aiPlan.reasoningTrace,
			...autoCommits.map(
				(commit) =>
					`Skipped AI diff analysis for ${commit.files.join(", ")}; ${commit.rationale}`,
			),
		]
			.filter(Boolean)
			.join("\n"),
	};
}

/**
 * Extracts <think>...</think> blocks from assistant content for models that
 * embed reasoning in the message text.
 *
 * @param {string} content
 * @returns {{ content: string, thinking: string|null }}
 */
function extractThinkTags(content) {
	const thoughts = [];
	const cleaned = content.replace(
		/<think>([\s\S]*?)<\/think>/gi,
		(_, thought) => {
			thoughts.push(thought.trim());
			return "";
		},
	);

	return {
		content: cleaned.trim(),
		thinking: thoughts.length ? thoughts.join("\n\n") : null,
	};
}

/**
 * Performs a non-streaming POST to /api/chat.
 *
 * @param {string}          baseUrl
 * @param {string}          model
 * @param {OllamaMessage[]} messages
 * @param {number}          timeoutMs
 * @returns {Promise<{ content: string, thinking: string|null }>}
 */
export async function ollamaChat(
	baseUrl,
	model,
	messages,
	timeoutMs = 120_000,
) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const url = `${baseUrl}/api/chat`;

	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, messages, stream: false }),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (err.name === "AbortError") {
			throw new Error(`Ollama request timed out after ${timeoutMs / 1000}s`);
		}
		throw new Error(
			`Cannot reach Ollama at ${baseUrl}. Is it running?\n  -> ${err.message}`,
		);
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Ollama API error ${response.status}: ${body}`);
	}

	const data = await response.json();
	const rawContent = data?.message?.content;
	if (typeof rawContent !== "string") {
		throw new Error(
			"Unexpected Ollama response shape - missing message.content",
		);
	}

	const extracted = extractThinkTags(rawContent);
	const thought =
		data?.thinking ?? data?.message?.thinking ?? extracted.thinking;

	return {
		content: extracted.content.trim(),
		thinking:
			typeof thought === "string" && thought.trim() ? thought.trim() : null,
	};
}

function printThinking(title, thinking) {
	if (!thinking) return;
	console.log(`\n\x1b[90m=== AI Thinking: ${title} ===\x1b[0m`);
	console.log("\x1b[90m%s\x1b[0m", thinking);
	console.log("\x1b[90m==============================\x1b[0m\n");
}

function extractJson(text) {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const source = fenced ? fenced[1] : text;
	const jsonMatch = source.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
	return jsonMatch ? jsonMatch[0] : source.trim();
}

function parseJsonResponse(text, label) {
	const json = extractJson(text);
	try {
		return JSON.parse(json);
	} catch {
		throw new Error(
			`Ollama returned non-JSON response for ${label}.\nExtracted response:\n${json}`,
		);
	}
}

function normalizeStringArray(value) {
	const array = Array.isArray(value) ? value : value ? [value] : [];
	return array
		.map((item) => {
			if (typeof item === "string") return item;
			if (item && typeof item === "object") {
				return item.file || item.filename || item.path || item.name || "";
			}
			return String(item ?? "");
		})
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeFileSelection(selected, remaining) {
	const remainingSet = new Set(remaining);
	const valid = normalizeStringArray(selected).filter((file) =>
		remainingSet.has(file),
	);
	return [...new Set(valid)].slice(0, MAX_SCHEDULER_FILES);
}

function fallbackSelection(fileIndex, analyzedFiles) {
	const analyzed = new Set(analyzedFiles);
	const remaining = fileIndex.filter((file) => !analyzed.has(file.path));
	if (!remaining.length) return [];

	const first = remaining[0];
	const firstDir = first.path.includes("/")
		? first.path.split("/").slice(0, -1).join("/")
		: "";
	const firstExt = first.extension;

	return remaining
		.filter((file) => {
			const dir = file.path.includes("/")
				? file.path.split("/").slice(0, -1).join("/")
				: "";
			return dir === firstDir || (firstExt && file.extension === firstExt);
		})
		.slice(0, MAX_SCHEDULER_FILES)
		.map((file) => file.path);
}

function compactMemory(memory) {
	return {
		analyzed_files: memory.analyzed_files,
		knowledge: memory.knowledge.slice(-40),
		themes: [...new Set(memory.themes)].slice(-20),
		open_questions: memory.open_questions.slice(-15),
	};
}

function normalizeObservationResult(parsed) {
	return {
		observations: normalizeStringArray(
			parsed.observations || parsed.changes || parsed.summary,
		),
		possible_commit_scope:
			typeof parsed.possible_commit_scope === "string"
				? parsed.possible_commit_scope
				: typeof parsed.scope === "string"
					? parsed.scope
					: "",
		notes_for_next_iteration:
			typeof parsed.notes_for_next_iteration === "string"
				? parsed.notes_for_next_iteration
				: typeof parsed.notes === "string"
					? parsed.notes
					: "",
		themes: normalizeStringArray(parsed.themes),
		open_questions: normalizeStringArray(parsed.open_questions),
	};
}

function adjustCommitCount(commits, targetCount) {
	const totalFiles = commits.reduce(
		(sum, commit) => sum + commit.files.length,
		0,
	);
	const target = clampCommitTarget(targetCount, totalFiles);
	if (!target) return commits;

	const adjusted = commits.map((commit) => ({
		...commit,
		files: [...commit.files],
	}));

	while (adjusted.length < target) {
		const index = adjusted.findIndex((commit) => commit.files.length > 1);
		if (index === -1) break;

		const source = adjusted[index];
		const file = source.files.pop();
		adjusted.splice(index + 1, 0, {
			...source,
			files: [file],
			message: commitMessageForFile(file, source.message),
			rationale: `Split from a larger group to match the requested commit count.`,
		});
	}

	while (adjusted.length > target && adjusted.length > 1) {
		const last = adjusted.pop();
		const previous = adjusted[adjusted.length - 1];
		previous.files.push(...last.files);
		previous.rationale = [previous.rationale, last.rationale]
			.filter(Boolean)
			.join(" ");
	}

	return adjusted;
}

function normalizeCommitPlan(
	parsed,
	fallbackSummary,
	allowedFiles,
	targetCommitCount,
) {
	const allowed = new Set(allowedFiles);
	const used = new Set();

	const findArray = (obj) => {
		if (Array.isArray(obj)) return obj;
		if (!obj || typeof obj !== "object") return null;
		for (const key in obj) {
			if (Array.isArray(obj[key])) return obj[key];
			const nested = findArray(obj[key]);
			if (nested) return nested;
		}
		return null;
	};

	const rawCommits = findArray(parsed) || [];
	const commits = rawCommits
		.map((commit, index) => {
			const files = normalizeStringArray(
				commit.files || commit.Files || commit.paths || commit.file_paths,
			).filter((file) => {
				if (!allowed.has(file) || used.has(file)) return false;
				used.add(file);
				return true;
			});

			return {
				id: Number(commit.id || commit.Id || index + 1),
				message:
					commit.message ||
					commit.Message ||
					commit.commit_message ||
					commit.title ||
					commit.subject ||
					`chore: update files ${index + 1}`,
				files,
				rationale:
					commit.rationale ||
					commit.Rationale ||
					commit.reason ||
					commit.explanation ||
					"",
			};
		})
		.filter((commit) => commit.files.length);

	if (!commits.length) {
		throw new Error(
			"Commit plan is empty or malformed - no valid commits array found.",
		);
	}

	const missingFiles = allowedFiles.filter((file) => !used.has(file));
	if (missingFiles.length) {
		commits.push({
			id: commits.length + 1,
			message: "chore(staged): update remaining files",
			files: missingFiles,
			rationale:
				"Files were analyzed but omitted from the model commit grouping.",
		});
	}

	const adjustedCommits = adjustCommitCount(commits, targetCommitCount);

	return {
		summary:
			parsed.summary || parsed.Summary || parsed.description || fallbackSummary,
		commits: adjustedCommits.map((commit, index) => ({
			...commit,
			id: index + 1,
		})),
	};
}

function fallbackGitignoreSuggestions(fileIndex, gitignoreContent) {
	const ignored = new Set(
		gitignoreContent
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#")),
	);
	const rules = [
		{
			test: (path) => path === ".DS_Store" || path.endsWith("/.DS_Store"),
			pattern: ".DS_Store",
			reason: "macOS metadata file",
		},
		{
			test: (path) => path.includes("node_modules/"),
			pattern: "node_modules/",
			reason: "npm dependency directory",
		},
		{
			test: (path) => path.includes("vendor/"),
			pattern: "vendor/",
			reason: "vendored dependency directory",
		},
		{
			test: (path) => path.includes("vendors/"),
			pattern: "vendors/",
			reason: "vendored dependency directory",
		},
		{
			test: (path) => path.includes("dist/"),
			pattern: "dist/",
			reason: "generated build output",
		},
		{
			test: (path) => path.includes("build/"),
			pattern: "build/",
			reason: "generated build output",
		},
		{
			test: (path) => path.endsWith(".log"),
			pattern: "*.log",
			reason: "log file",
		},
	];

	const suggestions = [];
	for (const rule of rules) {
		const matched_files = fileIndex.map((file) => file.path).filter(rule.test);
		if (matched_files.length && !ignored.has(rule.pattern)) {
			suggestions.push({
				pattern: rule.pattern,
				reason: rule.reason,
				matched_files,
			});
		}
	}

	return suggestions;
}

function normalizeGitignoreSuggestions(parsed, fileIndex, gitignoreContent) {
	const staged = new Set(fileIndex.map((file) => file.path));
	const existing = new Set(
		gitignoreContent
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#")),
	);
	const rawSuggestions = Array.isArray(parsed?.suggestions)
		? parsed.suggestions
		: [];

	return rawSuggestions
		.map((item) => {
			const pattern =
				typeof item.pattern === "string" ? item.pattern.trim() : "";
			const matched_files = normalizeStringArray(
				item.matched_files || item.files,
			).filter((file) => staged.has(file));

			return {
				pattern,
				reason:
					typeof item.reason === "string"
						? item.reason.trim()
						: "Looks like generated or local-only content.",
				matched_files,
			};
		})
		.filter(
			(item) =>
				item.pattern &&
				item.matched_files.length &&
				!existing.has(item.pattern),
		);
}

function mergeGitignoreSuggestions(...groups) {
	const byPattern = new Map();
	for (const group of groups) {
		for (const item of group) {
			const existing = byPattern.get(item.pattern);
			if (!existing) {
				byPattern.set(item.pattern, {
					...item,
					matched_files: [...new Set(item.matched_files)],
				});
				continue;
			}

			existing.matched_files = [
				...new Set([...existing.matched_files, ...item.matched_files]),
			];
		}
	}

	return [...byPattern.values()];
}

function buildFallbackPlan(memory, targetCommitCount) {
	const files = memory.analyzed_files;
	const scopes = [...new Set(memory.themes.filter(Boolean))];
	const scope = scopes[0] || "staged";
	const target = clampCommitTarget(targetCommitCount, files.length);

	if (target && target > 1) {
		const commits = files.map((file, index) => ({
			id: index + 1,
			message:
				`chore(${scope}): update ${basename(file).replace(/\.[^.]+$/, "")}`.slice(
					0,
					60,
				),
			files: [file],
			rationale: "Split by file to match the requested commit count.",
		}));

		return {
			summary:
				memory.knowledge[0] ||
				"Automated commit grouping based on staged files.",
			commits: adjustCommitCount(commits, target),
		};
	}

	return {
		summary:
			memory.knowledge[0] || "Automated commit grouping based on staged files.",
		commits: [
			{
				id: 1,
				message: `chore(${scope}): update staged files`,
				files,
				rationale:
					memory.knowledge.slice(0, 3).join("; ") ||
					"Grouped from staged diff analysis.",
			},
		],
	};
}

const SCHEDULER_SYSTEM = `You are a commit planning scheduler.
Choose only the next staged files to inspect. Do not analyze the code yet.
Return ONLY valid JSON.`;

const ANALYZER_SYSTEM = `You are a careful diff analyst.
Use only the provided diff. Do not invent files, APIs, behavior, or commit messages.
Return ONLY valid JSON.`;

const FINALIZER_SYSTEM = `You are a strict Git commit planner.
Use only analyzed memory and listed files. Do not invent files or features.
Return ONLY valid JSON.`;

const SUMMARY_SYSTEM = `You summarize an incremental staged-diff analysis for a human.
Use only the provided memory and commit plan. Return plain text, not JSON.`;

const GITIGNORE_SYSTEM = `You detect staged files that look accidental and should be ignored.
Use only the provided file list and existing .gitignore content.
Return ONLY valid JSON.`;

const MEMORY_SYSTEM = `You maintain a compact project memory for a commit assistant.
Keep only stable project structure and important conventions. Return plain text.`;

const DOC_SYSTEM = `You update project documentation after an approved commit workflow.
Use only the provided memory and commit plan. Return plain Markdown only.`;

const PR_SYSTEM = `You write clear pull request descriptions for software changes.
Use only the provided memory and commit plan. Return plain Markdown only.`;

function stripMarkdownFence(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
	return (fenced ? fenced[1] : trimmed).trim();
}

async function chooseNextFiles(baseUrl, model, fileIndex, memory, timeoutMs) {
	const remaining = fileIndex
		.map((file) => file.path)
		.filter((file) => !memory.analyzed_files.includes(file));

	if (!remaining.length) return { selected: [], why: "" };

	const messages = [
		{ role: "system", content: SCHEDULER_SYSTEM },
		{
			role: "user",
			content: `Files:
${JSON.stringify(fileIndex, null, 2)}

Already analyzed:
${JSON.stringify(memory.analyzed_files, null, 2)}

Project memory:
${memory.project_memory || "none"}

Iteration memory:
${JSON.stringify(compactMemory(memory), null, 2)}

Choose ONLY the next files to inspect.

Rules:
- maximum ${MAX_SCHEDULER_FILES} files
- prefer related files
- selected files must be exact paths from remaining files
- return strict JSON with this schema:
{
  "selected": ["exact/path.js"],
  "why": "short reason"
}`,
		},
	];

	let parsed = {};
	try {
		const { content, thinking } = await ollamaChat(
			baseUrl,
			model,
			messages,
			timeoutMs,
		);
		printThinking("scheduler", thinking);
		parsed = parseJsonResponse(content, "file scheduler");
	} catch {
		return {
			selected: fallbackSelection(fileIndex, memory.analyzed_files),
			why: "deterministic fallback after scheduler JSON failure",
		};
	}

	const selected = normalizeFileSelection(
		parsed.selected || parsed.files,
		remaining,
	);

	return {
		selected: selected.length
			? selected
			: fallbackSelection(fileIndex, memory.analyzed_files),
		why: typeof parsed.why === "string" ? parsed.why : "",
	};
}

async function analyzeSelectedFiles(
	baseUrl,
	model,
	selected,
	diff,
	memory,
	timeoutMs,
) {
	const messages = [
		{ role: "system", content: ANALYZER_SYSTEM },
		{
			role: "user",
			content: `Analyze these staged file changes.

Selected files:
${JSON.stringify(selected, null, 2)}

Project memory:
${memory.project_memory || "none"}

Iteration memory so far:
${JSON.stringify(compactMemory(memory), null, 2)}

[STAGED DIFF START]
${diff}
[STAGED DIFF END]

Rules:
- use only the provided diff
- no assumptions
- no invented paths
- no commit message yet
- return strict JSON:
{
  "observations": ["what changed"],
  "possible_commit_scope": "short scope",
  "themes": ["theme"],
  "open_questions": [],
  "notes_for_next_iteration": "short memory note"
}`,
		},
	];

	try {
		const { content, thinking } = await ollamaChat(
			baseUrl,
			model,
			messages,
			timeoutMs,
		);
		printThinking(`diff ${selected.join(", ")}`, thinking);
		return normalizeObservationResult(
			parseJsonResponse(content, "diff analysis"),
		);
	} catch {
		return {
			observations: [`Inspected staged changes for ${selected.join(", ")}`],
			possible_commit_scope: selected[0]?.split("/")[0] || "staged",
			notes_for_next_iteration:
				"Diff analysis used a deterministic fallback after invalid model JSON.",
			themes: [],
			open_questions: [],
		};
	}
}

async function finalizeCommitPlan(
	baseUrl,
	model,
	memory,
	timeoutMs,
	targetCommitCount,
) {
	const target = clampCommitTarget(
		targetCommitCount,
		memory.analyzed_files.length,
	);
	const targetRule = target
		? `produce exactly ${target} commit${target === 1 ? "" : "s"} unless doing so would require an empty commit`
		: "choose the number of commits that best matches logical change boundaries";

	const messages = [
		{ role: "system", content: FINALIZER_SYSTEM },
		{
			role: "user",
			content: `You analyzed the staged diff incrementally.

Project memory:
${memory.project_memory || "none"}

Iteration memory:
${JSON.stringify(compactMemory(memory), null, 2)}

Allowed files:
${JSON.stringify(memory.analyzed_files, null, 2)}

Produce commit groups.

Rules:
- use ONLY allowed files
- every allowed file should appear in exactly one commit
- ${targetRule}
- conventional commits only
- allowed types: feat, fix, chore, docs, refactor, test, build
- subject <= 60 chars, lower-case, imperative mood
- return strict JSON:
{
  "summary": "one-sentence overall summary",
  "commits": [
    {
      "id": 1,
      "message": "type(scope): subject",
      "files": ["exact/path.js"],
      "rationale": "why these files belong together"
    }
  ]
}`,
		},
	];

	const { content, thinking } = await ollamaChat(
		baseUrl,
		model,
		messages,
		timeoutMs,
	);
	printThinking("final commit plan", thinking);

	return normalizeCommitPlan(
		parseJsonResponse(content, "final commit plan"),
		"Automated commit grouping based on staged files.",
		memory.analyzed_files,
		target,
	);
}

async function summarizeReasoning(baseUrl, model, memory, plan, timeoutMs) {
	const messages = [
		{ role: "system", content: SUMMARY_SYSTEM },
		{
			role: "user",
			content: `Project memory:
${memory.project_memory || "none"}

Iteration memory:
${JSON.stringify(compactMemory(memory), null, 2)}

Commit plan:
${JSON.stringify(plan, null, 2)}

Write a concise inspectable reasoning trace. This is not hidden chain-of-thought;
it should explain what was inspected and why the final groups make sense.`,
		},
	];

	const { content, thinking } = await ollamaChat(
		baseUrl,
		model,
		messages,
		timeoutMs,
	);
	printThinking("summary", thinking);
	return content.trim();
}

/**
 * Asks the model whether staged files look like ignore-list mistakes.
 *
 * @param {string} baseUrl
 * @param {string} model
 * @param {Array<{ path: string, additions: number|null, deletions: number|null, extension: string }>} fileIndex
 * @param {string} gitignoreContent
 * @param {string} projectMemory
 * @param {number} timeoutMs
 * @returns {Promise<Array<{ pattern: string, reason: string, matched_files: string[] }>>}
 */
export async function suggestGitignoreEntries(
	baseUrl,
	model,
	fileIndex,
	gitignoreContent,
	projectMemory,
	timeoutMs,
) {
	const fallback = fallbackGitignoreSuggestions(fileIndex, gitignoreContent);
	const messages = [
		{ role: "system", content: GITIGNORE_SYSTEM },
		{
			role: "user",
			content: `Staged files:
${JSON.stringify(fileIndex, null, 2)}

Existing .gitignore:
${gitignoreContent.trim() || "(missing or empty)"}

Project memory:
${projectMemory || "none"}

Find files or directories that look accidentally staged and should probably be added to .gitignore.

Rules:
- suggest only common generated, dependency, cache, editor, OS, secret, or build artifacts
- do not suggest normal source, config, docs, tests, lockfiles, or project files
- each matched file must be an exact staged path
- return strict JSON:
{
  "suggestions": [
    {
      "pattern": "node_modules/",
      "reason": "dependency directory",
      "matched_files": ["node_modules/pkg/index.js"]
    }
  ]
}`,
		},
	];

	try {
		const { content, thinking } = await ollamaChat(
			baseUrl,
			model,
			messages,
			timeoutMs,
		);
		printThinking("gitignore check", thinking);
		const aiSuggestions = normalizeGitignoreSuggestions(
			parseJsonResponse(content, "gitignore suggestions"),
			fileIndex,
			gitignoreContent,
		);
		return mergeGitignoreSuggestions(aiSuggestions, fallback);
	} catch {
		return fallback;
	}
}

/**
 * Builds the next compact .agents/.automait memory.
 *
 * @param {string} baseUrl
 * @param {string} model
 * @param {string} previousMemory
 * @param {{ analyzed_files: string[], knowledge: string[], themes: string[], open_questions: string[] }} memory
 * @param {CommitPlan} plan
 * @param {string[]} projectFolders
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export async function generateProjectMemory(
	baseUrl,
	model,
	previousMemory,
	memory,
	plan,
	projectFolders,
	timeoutMs,
) {
	const messages = [
		{ role: "system", content: MEMORY_SYSTEM },
		{
			role: "user",
			content: `Previous memory:
${previousMemory || "none"}

Latest analysis memory:
${JSON.stringify(compactMemory(memory), null, 2)}

Latest commit plan:
${JSON.stringify(plan, null, 2)}

Main project folders:
${projectFolders.length ? projectFolders.join(", ") : "none detected"}

Write the next .agents/.automait content.

Rules:
- maximum 12 short lines
- list main project folders and what they contain
- include only stable important information that helps future commits
- do not include temporary diff details, commit messages, or long explanations
- plain text only`,
		},
	];

	const { content, thinking } = await ollamaChat(
		baseUrl,
		model,
		messages,
		timeoutMs,
	);
	printThinking("project memory", thinking);
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 12)
		.join("\n")
		.slice(0, 1800);
}

/**
 * Updates README content from the latest workflow memory and commit plan.
 *
 * @param {string} baseUrl
 * @param {string} model
 * @param {string} readmeContent
 * @param {string} projectMemory
 * @param {CommitPlan} plan
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export async function generateReadmeUpdate(
	baseUrl,
	model,
	readmeContent,
	projectMemory,
	plan,
	timeoutMs,
) {
	const messages = [
		{ role: "system", content: DOC_SYSTEM },
		{
			role: "user",
			content: `Existing README.md:
${readmeContent || "(missing)"}

Current project memory:
${projectMemory || "none"}

Latest commit plan:
${JSON.stringify({ summary: plan.summary, commits: plan.commits }, null, 2)}

Update README.md so it reflects only stable user-facing behavior from the latest changes.

Rules:
- preserve the existing structure and tone where possible
- keep unrelated content unchanged
- do not mention implementation details unless the README already documents that area
- return the full README.md Markdown content only`,
		},
	];

	const { content, thinking } = await ollamaChat(
		baseUrl,
		model,
		messages,
		timeoutMs,
	);
	printThinking("README update", thinking);
	return stripMarkdownFence(content);
}

/**
 * Updates or creates CHANGELOG content from the latest workflow memory and plan.
 *
 * @param {string} baseUrl
 * @param {string} model
 * @param {string} changelogContent
 * @param {string} projectMemory
 * @param {CommitPlan} plan
 * @param {string} today
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export async function generateChangelogUpdate(
	baseUrl,
	model,
	changelogContent,
	projectMemory,
	plan,
	today,
	timeoutMs,
) {
	const messages = [
		{ role: "system", content: DOC_SYSTEM },
		{
			role: "user",
			content: `Existing CHANGELOG.md:
${changelogContent || "(missing)"}

Current project memory:
${projectMemory || "none"}

Latest commit plan:
${JSON.stringify({ summary: plan.summary, commits: plan.commits }, null, 2)}

Update CHANGELOG.md with an entry dated ${today}.

Rules:
- preserve existing changelog content
- if the file is missing, create a conventional Markdown changelog
- summarize user-facing changes first, then maintenance/internal changes when useful
- do not invent version numbers, issue numbers, or unreleased features
- return the full CHANGELOG.md Markdown content only`,
		},
	];

	const { content, thinking } = await ollamaChat(
		baseUrl,
		model,
		messages,
		timeoutMs,
	);
	printThinking("CHANGELOG update", thinking);
	return stripMarkdownFence(content);
}

/**
 * Writes a pull request message from the latest workflow memory and plan.
 *
 * @param {string} baseUrl
 * @param {string} model
 * @param {string} projectMemory
 * @param {CommitPlan} plan
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export async function generatePullRequestMessage(
	baseUrl,
	model,
	projectMemory,
	plan,
	timeoutMs,
) {
	const messages = [
		{ role: "system", content: PR_SYSTEM },
		{
			role: "user",
			content: `Current project memory:
${projectMemory || "none"}

Latest commit plan:
${JSON.stringify({ summary: plan.summary, commits: plan.commits }, null, 2)}

Write a polished pull request message.

Rules:
- include a short title
- include concise Summary and Testing sections
- mention tests as "Not run (not requested)" if no test information is provided
- use only the provided memory and plan
- return Markdown only`,
		},
	];

	const { content, thinking } = await ollamaChat(
		baseUrl,
		model,
		messages,
		timeoutMs,
	);
	printThinking("pull request message", thinking);
	return stripMarkdownFence(content);
}

/**
 * Asks Ollama to analyze staged changes incrementally and return a commit plan.
 *
 * @param {string} baseUrl
 * @param {string} model
 * @param {string} diff
 * @param {number} timeoutMs
 * @param {{ fileIndex?: Array<{ path: string, additions: number|null, deletions: number|null, extension: string, status?: string }>, getDiffForFiles?: (files: string[]) => Promise<string|null>, projectMemory?: string, targetCommitCount?: number }} [options]
 * @returns {Promise<CommitPlan>}
 */
export async function generateCommitPlan(
	baseUrl,
	model,
	diff,
	timeoutMs,
	options = {},
) {
	const allFiles = options.fileIndex?.length
		? options.fileIndex
		: [...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map((match) => ({
				path: match[1],
				additions: null,
				deletions: null,
				extension: match[1].match(/\.([^.\\/]+)$/)?.[1] ?? "",
			}));

	if (!allFiles.length) {
		throw new Error("No staged files found for commit planning.");
	}

	const { analyzed: fileIndex, autoDescribed } =
		partitionAutoDescribedFiles(allFiles);
	const autoCommits = buildAutoDescribedCommits(autoDescribed);
	const totalTargetCommitCount = clampCommitTarget(
		options.targetCommitCount,
		allFiles.length,
	);
	const analyzedTargetCommitCount = totalTargetCommitCount
		? clampCommitTarget(
				totalTargetCommitCount - autoCommits.length,
				fileIndex.length,
			)
		: null;

	const memory = {
		analyzed_files: [],
		knowledge: [],
		themes: [],
		open_questions: [],
		project_memory: options.projectMemory || "",
	};

	if (!fileIndex.length) {
		const plan = {
			summary: `${autoCommits.length} generated dependency file(s) handled with deterministic commit messages.`,
			commits: autoCommits,
			reasoningTrace: autoCommits
				.map(
					(commit) =>
						`Skipped AI diff analysis for ${commit.files.join(", ")}; ${commit.rationale}`,
				)
				.join("\n"),
			projectMemory: memory,
		};
		return plan;
	}

	const trace = [];
	const maxIterations = Math.max(
		fileIndex.length * MAX_ITERATIONS_FACTOR,
		fileIndex.length,
	);

	for (
		let iteration = 1;
		memory.analyzed_files.length < fileIndex.length;
		iteration++
	) {
		if (iteration > maxIterations) {
			throw new Error(
				"Planner stopped after too many iterations without covering all staged files.",
			);
		}

		const selection = await chooseNextFiles(
			baseUrl,
			model,
			fileIndex,
			memory,
			timeoutMs,
		);
		const selected = selection.selected.filter(
			(file) => !memory.analyzed_files.includes(file),
		);

		if (!selected.length) {
			selected.push(...fallbackSelection(fileIndex, memory.analyzed_files));
		}
		if (!selected.length) break;

		const selectedDiff = options.getDiffForFiles
			? await options.getDiffForFiles(selected)
			: diff;

		if (!selectedDiff) {
			for (const file of selected) memory.analyzed_files.push(file);
			memory.open_questions.push(
				`No staged diff was available for ${selected.join(", ")}`,
			);
			continue;
		}

		const analysis = await analyzeSelectedFiles(
			baseUrl,
			model,
			selected,
			selectedDiff,
			memory,
			timeoutMs,
		);

		memory.analyzed_files.push(...selected);
		memory.analyzed_files = [...new Set(memory.analyzed_files)];
		memory.knowledge.push(...analysis.observations);
		if (analysis.notes_for_next_iteration)
			memory.knowledge.push(analysis.notes_for_next_iteration);
		if (analysis.possible_commit_scope)
			memory.themes.push(analysis.possible_commit_scope);
		memory.themes.push(...analysis.themes);
		memory.open_questions.push(...analysis.open_questions);

		trace.push(
			`Iteration ${iteration}: inspected ${selected.join(", ")}${
				selection.why ? ` (${selection.why})` : ""
			}. ${analysis.observations.slice(0, 2).join(" ")}`,
		);
	}

	let plan;
	try {
		plan = await finalizeCommitPlan(
			baseUrl,
			model,
			memory,
			timeoutMs,
			analyzedTargetCommitCount,
		);
	} catch {
		plan = buildFallbackPlan(memory, analyzedTargetCommitCount);
	}

	try {
		plan.reasoningTrace = await summarizeReasoning(
			baseUrl,
			model,
			memory,
			plan,
			timeoutMs,
		);
	} catch {
		plan.reasoningTrace = trace.join("\n");
	}

	plan.projectMemory = memory;

	return mergeCommitPlans(plan, autoCommits);
}

/**
 * @typedef {Object} CommitEntry
 * @property {number}   id
 * @property {string}   message
 * @property {string[]} files
 * @property {string}   rationale
 */

/**
 * @typedef {Object} CommitPlan
 * @property {string}        summary
 * @property {CommitEntry[]} commits
 * @property {string}        [reasoningTrace]
 * @property {{ analyzed_files: string[], knowledge: string[], themes: string[], open_questions: string[], project_memory?: string }} [projectMemory]
 */
