/**
 * git.js
 * Thin, promise-based wrappers around simple-git for the operations
 * automit needs: diff, stage, reset, commit, and status helpers.
 */

import { simpleGit } from "simple-git";

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns a configured simple-git instance rooted at the given directory.
 * @param {string} [cwd=process.cwd()]
 */
function git(cwd = process.cwd()) {
	return simpleGit({ baseDir: cwd, binary: "git", trimmed: true });
}

async function hasHead(cwd) {
	try {
		await git(cwd).revparse(["--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

async function unstageAddedFiles(files, cwd) {
	if (!files.length) return;
	const g = git(cwd);
	await g.raw(["rm", "--cached", "-r", "-f", "--", ...files]);
}

async function clearIndex(cwd) {
	const g = git(cwd);
	await g.raw(["read-tree", "--empty"]);
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

/**
 * Returns the unified diff of all currently staged changes.
 * Returns null if nothing is staged.
 *
 * @param {string} [cwd]
 * @returns {Promise<string|null>}
 */
export async function getStagedDiff(cwd) {
	const g = git(cwd);
	const diff = await g.diff(["--cached"]);
	return diff.trim() || null;
}

/**
 * Returns the staged unified diff for a specific list of files.
 *
 * @param {string[]} files
 * @param {string} [cwd]
 * @returns {Promise<string|null>}
 */
export async function getStagedDiffForFiles(files, cwd) {
	if (!files.length) return null;
	const g = git(cwd);
	const diff = await g.diff(["--cached", "--", ...files]);
	return diff.trim() || null;
}

/**
 * Returns deterministic metadata for staged files without sending full diffs
 * to the model.
 *
 * @param {string} [cwd]
 * @returns {Promise<Array<{ path: string, additions: number|null, deletions: number|null, extension: string, status: string }>>}
 */
export async function getStagedDiffIndex(cwd) {
	const g = git(cwd);
	const output = await g.diff(["--cached", "--numstat"]);
	const statusOutput = await g.diff(["--cached", "--name-status"]);
	const statusByPath = new Map(
		statusOutput
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [statusRaw, ...pathParts] = line.split(/\t+/);
				const path = pathParts.at(-1);
				return [path, statusRaw?.[0] || "M"];
			}),
	);

	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [addsRaw, delsRaw, ...pathParts] = line.split(/\t+/);
			const path = pathParts.join("\t");
			const extensionMatch = path.match(/\.([^.\\/]+)$/);

			return {
				path,
				additions: addsRaw === "-" ? null : Number(addsRaw),
				deletions: delsRaw === "-" ? null : Number(delsRaw),
				extension: extensionMatch?.[1] ?? "",
				status: statusByPath.get(path) || "M",
			};
		});
}

/**
 * Returns an array of file paths that are currently staged (index vs HEAD).
 *
 * @param {string} [cwd]
 * @returns {Promise<string[]>}
 */
export async function getStagedFiles(cwd) {
	const g = git(cwd);
	const status = await g.status();
	return status.staged; // string[] of relative paths
}

/**
 * Returns file paths with working-tree changes that are not already staged.
 * Includes untracked files and modified tracked files that are not in the index.
 *
 * @param {string} [cwd]
 * @returns {Promise<string[]>}
 */
export async function getUnstagedFiles(cwd) {
	const g = git(cwd);
	const status = await g.status();
	const staged = new Set(status.staged);

	return [
		...new Set(
			status.files
				.filter((file) => file.working_dir && file.working_dir !== " ")
				.filter((file) => !staged.has(file.path))
				.map((file) => file.path),
		),
	];
}

// ─── Staging control ──────────────────────────────────────────────────────────

/**
 * Unstages ALL currently staged files (git reset HEAD).
 * Keeps working-tree changes intact.
 *
 * @param {string} [cwd]
 */
export async function unstageAll(cwd) {
	const g = git(cwd);
	if (!(await hasHead(cwd))) {
		await clearIndex(cwd);
		return;
	}

	await g.reset(["HEAD"]); // mixed reset — index is cleared, working tree preserved
}

/**
 * Unstages only the provided files.
 *
 * @param {string[]} files
 * @param {string} [cwd]
 */
export async function unstageFiles(files, cwd) {
	if (!files.length) return;
	const g = git(cwd);
	if (!(await hasHead(cwd))) {
		await unstageAddedFiles(files, cwd);
		return;
	}

	await g.reset(["HEAD", "--", ...files]);
}

/**
 * Stages the given list of files (git add <files>).
 *
 * @param {string[]} files  - Relative paths to stage
 * @param {string}   [cwd]
 */
export async function stageFiles(files, cwd) {
	if (!files.length) return;
	const g = git(cwd);
	await g.add(files);
}

// ─── Commit ───────────────────────────────────────────────────────────────────

/**
 * Creates a Git commit with the given message.
 * The index must already contain the desired staged files.
 *
 * @param {string} message  - The commit message
 * @param {string} [cwd]
 * @returns {Promise<string>}  - The new commit SHA
 */
export async function createCommit(message, cwd) {
	const g = git(cwd);
	const result = await g.commit(message);
	return result.commit; // short SHA
}

// ─── Status helpers ───────────────────────────────────────────────────────────

/**
 * Returns true if the provided file paths include files that are currently
 * tracked in the repository (exist at HEAD or in the index).
 * Used to filter out files listed in the plan that don't exist in the diff.
 *
 * @param {string[]} files
 * @param {string}   [cwd]
 * @returns {Promise<string[]>}  - Subset of files that are actually staged
 */
export async function filterStagedFiles(files, cwd) {
	const staged = await getStagedFiles(cwd);
	const stagedSet = new Set(staged);
	return files.filter((f) => stagedSet.has(f));
}

/**
 * Returns the full `git status` object (simple-git StatusResult).
 * @param {string} [cwd]
 */
export async function getStatus(cwd) {
	return git(cwd).status();
}

/**
 * Returns true if the current directory (or cwd) is inside a Git repo.
 * @param {string} [cwd]
 */
export async function isGitRepo(cwd) {
	try {
		await git(cwd).revparse(["--is-inside-work-tree"]);
		return true;
	} catch {
		return false;
	}
}
