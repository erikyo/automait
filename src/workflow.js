/**
 * workflow.js
 * Orchestrates the full 6-step automait workflow:
 *   1. Staging detection
 *   2. AI planning
 *   3. Plan presentation
 *   4. Interactive sequential committing
 *   5. Cleanup & restore
 *   6. Optional README, changelog, and PR follow-ups
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { input, select } from "@inquirer/prompts";

import {
	createCommit,
	getStagedDiff,
	getStagedDiffForFiles,
	getStagedDiffIndex,
	getStagedFiles,
	getUnstagedFiles,
	stageFiles,
	unstageAll,
	unstageFiles,
} from "./git.js";
import { appendGitignorePatterns, readGitignore } from "./ignore.js";
import {
	getProjectFolderIndex,
	MEMORY_PATH,
	readProjectMemory,
	writeProjectMemory,
} from "./memory.js";
import {
	generateChangelogUpdate,
	generateCommitPlan,
	generateProjectMemory,
	generatePullRequestMessage,
	generateReadmeUpdate,
	suggestGitignoreEntries,
} from "./ollama.js";

import {
	c,
	printCommitSkipped,
	printCommitSuccess,
	printFinalSummary,
	printHeader,
	printPlan,
	printWarning,
	spinner,
} from "./ui.js";

async function readTextFile(filePath) {
	try {
		return await readFile(filePath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return "";
		throw err;
	}
}

async function askYesNo(message) {
	return select({
		message,
		choices: [
			{ name: "Yes", value: true },
			{ name: "No", value: false },
		],
	});
}

function requireGeneratedMarkdown(content, label) {
	const trimmed = content.trim();
	if (trimmed.length < 20) {
		throw new Error(`${label} generation returned empty content.`);
	}
	return trimmed;
}

async function runPostCommitFollowUps(config, cwd, plan, projectMemory) {
	printHeader("Step 6 · Follow-up docs");

	const updateReadme = await askYesNo("Do you need to update the README?");
	if (updateReadme) {
		const spin = spinner("Updating README.md with Ollama...");
		try {
			const readmePath = path.join(cwd, "README.md");
			const nextReadme = await generateReadmeUpdate(
				config.ollamaEndpoint,
				config.model,
				await readTextFile(readmePath),
				projectMemory,
				plan,
				config.timeoutMs,
			);
			await writeFile(
				readmePath,
				`${requireGeneratedMarkdown(nextReadme, "README").trimEnd()}\n`,
				"utf8",
			);
			await stageFiles(["README.md"], cwd);
			spin.succeed("Updated and staged README.md");
		} catch (err) {
			spin.warn("Could not update README.md");
			printWarning(err.message);
		}
	}

	const updateChangelog = await askYesNo(
		"Do you need to update the CHANGELOG?",
	);
	if (updateChangelog) {
		const spin = spinner("Updating CHANGELOG.md with Ollama...");
		try {
			const changelogPath = path.join(cwd, "CHANGELOG.md");
			const today = new Date().toISOString().slice(0, 10);
			const nextChangelog = await generateChangelogUpdate(
				config.ollamaEndpoint,
				config.model,
				await readTextFile(changelogPath),
				projectMemory,
				plan,
				today,
				config.timeoutMs,
			);
			await writeFile(
				changelogPath,
				`${requireGeneratedMarkdown(nextChangelog, "CHANGELOG").trimEnd()}\n`,
				"utf8",
			);
			await stageFiles(["CHANGELOG.md"], cwd);
			spin.succeed("Updated and staged CHANGELOG.md");
		} catch (err) {
			spin.warn("Could not update CHANGELOG.md");
			printWarning(err.message);
		}
	}

	const writePrMessage = await askYesNo("Do you need a pull request message?");
	if (writePrMessage) {
		const spin = spinner("Writing pull request message with Ollama...");
		try {
			const prMessage = await generatePullRequestMessage(
				config.ollamaEndpoint,
				config.model,
				projectMemory,
				plan,
				config.timeoutMs,
			);
			const printablePrMessage = requireGeneratedMarkdown(
				prMessage,
				"Pull request message",
			);
			spin.succeed("Pull request message ready");
			console.log(`\n${c.accent.bold("Pull request message\n")}`);
			console.log(printablePrMessage);
			console.log();
		} catch (err) {
			spin.warn("Could not write pull request message");
			printWarning(err.message);
		}
	}
}

// ─── Main workflow entry point ────────────────────────────────────────────────

/**
 * Runs the complete automait workflow.
 *
 * @param {import('./config.js').Config} config
 * @param {{ dryRun?: boolean, cwd?: string, targetCommitCount?: number }} [opts]
 */
export async function runWorkflow(config, opts = {}) {
	const { dryRun = false, cwd = process.cwd(), targetCommitCount } = opts;

	// ── Step 1: Staging Detection ─────────────────────────────────────────────

	printHeader("Step 1 · Detecting staged changes");

	let diff = await getStagedDiff(cwd);
	let stagedFiles = await getStagedFiles(cwd);
	let diffIndex = await getStagedDiffIndex(cwd);

	const unstagedFiles = await getUnstagedFiles(cwd);
	if (unstagedFiles.length) {
		console.log(c.warning("\n  Changes not yet staged:"));
		for (const f of unstagedFiles) {
			console.log(`     ${c.muted("•")} ${c.accent(f)}`);
		}

		const includeUnstaged = await select({
			message: stagedFiles.length
				? "Which files should automait plan commits for?"
				: "No files are staged yet. What should automait do?",
			choices: stagedFiles.length
				? [
						{ name: "Only files I already staged", value: false },
						{ name: "All modified and untracked files", value: true },
					]
				: [
						{ name: "All modified and untracked files", value: true },
						{ name: "Abort so I can stage files myself", value: false },
					],
		});

		if (includeUnstaged) {
			if (dryRun) {
				printWarning("Dry-run mode enabled - unstaged files were not added.");
			} else {
				await stageFiles(unstagedFiles, cwd);
				console.log(
					c.success(
						`  ✔ Included ${unstagedFiles.length} unstaged file(s) in the plan`,
					),
				);

				diff = await getStagedDiff(cwd);
				stagedFiles = await getStagedFiles(cwd);
				diffIndex = await getStagedDiffIndex(cwd);
			}
		}
	}

	if (!diff) {
		throw new UserError(
			"No staged changes detected.\n" +
				"  Stage the changes you want automait to plan, then run it again:\n" +
				"    git add <files>\n" +
				"    automait",
		);
	}

	console.log(c.success(`  ✔ ${stagedFiles.length} file(s) staged:`));
	for (const f of stagedFiles) {
		console.log(`     ${c.muted("•")} ${c.accent(f)}`);
	}

	const projectMemory = await readProjectMemory(cwd);
	if (projectMemory) {
		console.log(c.muted(`\n  Loaded project memory from ${MEMORY_PATH}`));
	}

	const ignoreSpin = spinner(
		"Checking staged files for .gitignore mistakes...",
	);
	let ignoreSuggestions = [];
	try {
		ignoreSuggestions = await suggestGitignoreEntries(
			config.ollamaEndpoint,
			config.model,
			diffIndex,
			await readGitignore(cwd),
			projectMemory,
			config.timeoutMs,
		);
		ignoreSpin.stop();
	} catch (err) {
		ignoreSpin.warn("Could not run .gitignore check");
		printWarning(err.message);
	}

	if (ignoreSuggestions.length) {
		console.log(c.warning("\n  Possible .gitignore additions detected:"));
		for (const item of ignoreSuggestions) {
			console.log(
				`     ${c.accent(item.pattern)} ${c.muted(`- ${item.reason}`)}`,
			);
			console.log(`       ${c.muted(item.matched_files.join(", "))}`);
		}

		const matchedIgnoreFiles = [
			...new Set(ignoreSuggestions.flatMap((item) => item.matched_files)),
		];
		const addToGitignore = await select({
			message: "How should automait handle these likely ignored files?",
			choices: [
				{
					name: "Update .gitignore and unstage matched files",
					value: "yes-unstage",
				},
				{ name: "Only update and stage .gitignore", value: "yes" },
				{ name: "No - keep planning as-is", value: "no" },
			],
		});

		if (addToGitignore !== "no") {
			if (dryRun) {
				printWarning("Dry-run mode enabled - .gitignore was not modified.");
			} else {
				const added = await appendGitignorePatterns(
					ignoreSuggestions.map((item) => item.pattern),
					cwd,
				);
				if (added.length) {
					await stageFiles([".gitignore"], cwd);
					console.log(
						c.success(`  ✔ Added ${added.length} pattern(s) to .gitignore`),
					);
				}

				if (addToGitignore === "yes-unstage") {
					await unstageFiles(matchedIgnoreFiles, cwd);
					console.log(
						c.success(
							`  ✔ Unstaged ${matchedIgnoreFiles.length} matched file(s)`,
						),
					);
				}

				if (added.length || addToGitignore === "yes-unstage") {
					diff = await getStagedDiff(cwd);
					stagedFiles = await getStagedFiles(cwd);
					diffIndex = await getStagedDiffIndex(cwd);
				}
			}
		}
	}

	if (!diff) {
		throw new UserError(
			"No staged changes remain after handling ignored files.",
		);
	}

	// Keep a snapshot of staged files so we can restore them if needed
	const originalStagedFiles = [...stagedFiles];
	const originalStagedFileSet = new Set(originalStagedFiles);

	// ── Step 2: AI Planning ───────────────────────────────────────────────────

	printHeader("Step 2 · Generating commit plan with Ollama");

	const spin = spinner(
		`Talking to ${config.model} @ ${config.ollamaEndpoint} …`,
	);

	let plan;
	try {
		plan = await generateCommitPlan(
			config.ollamaEndpoint,
			config.model,
			diff,
			config.timeoutMs,
			{
				fileIndex: diffIndex,
				getDiffForFiles: (files) => getStagedDiffForFiles(files, cwd),
				projectMemory,
				targetCommitCount,
			},
		);
		spin.succeed(`Plan ready — ${plan.commits.length} proposed commit(s)`);
	} catch (err) {
		spin.fail("Ollama request failed");
		throw err;
	}

	let currentProjectMemory = projectMemory || "";
	try {
		const memorySpin = spinner(`Updating ${MEMORY_PATH}...`);
		const nextMemory = await generateProjectMemory(
			config.ollamaEndpoint,
			config.model,
			projectMemory,
			plan.projectMemory,
			{ summary: plan.summary, commits: plan.commits },
			await getProjectFolderIndex(cwd),
			config.timeoutMs,
		);
		await writeProjectMemory(nextMemory, cwd);
		currentProjectMemory = nextMemory;
		memorySpin.succeed(`Updated ${MEMORY_PATH}`);
	} catch (err) {
		printWarning(`Could not update ${MEMORY_PATH}: ${err.message}`);
	}

	// ── Step 3: Plan Presentation ─────────────────────────────────────────────

	printPlan(plan);

	// Ask user whether to proceed before touching anything
	const proceed = await select({
		message: "Proceed with this plan?",
		choices: [
			{ name: "Yes — walk me through each commit", value: "yes" },
			{ name: "Apply all commits automatically", value: "all" },
			{ name: "No — abort", value: "no" },
		],
	});

	if (proceed === "no") {
		console.log(c.warning("\n  Aborted — no changes made.\n"));
		return;
	}

	const autoApplyAll = proceed === "all";

	// ── Step 4: Interactive Sequential Committing ─────────────────────────────

	printHeader("Step 4 · Applying commits");

	let applied = 0;
	let skipped = 0;

	// Track which files from the original staged set have already been committed
	// so we know what to restore at the end.
	const committedFiles = new Set();

	for (const commit of plan.commits) {
		// Resolve against the original staged snapshot. Each successful commit
		// clears the live index, so the live staged set is not the right source
		// of truth for later commits in the same plan.
		const eligibleFiles = [...new Set(commit.files)].filter(
			(f) => originalStagedFileSet.has(f) && !committedFiles.has(f),
		);

		if (eligibleFiles.length === 0) {
			printWarning(
				`Commit #${commit.id} has no remaining files from the original staged set — skipping.`,
			);
			skipped++;
			continue;
		}

		// ── Decide action ────────────────────────────────────────────────────────

		let action;
		if (autoApplyAll) {
			action = "y";
		} else {
			action = await select({
				message:
					`Commit #${commit.id}  ${c.bold(commit.message)}\n` +
					`  Files: ${eligibleFiles.map((f) => c.accent(f)).join(", ")}`,
				choices: [
					{ name: "Apply", value: "y" },
					{ name: "Edit message", value: "e" },
					{ name: "Skip", value: "n" },
				],
			});
		}

		if (action === "n") {
			printCommitSkipped(commit.id);
			skipped++;
			continue;
		}

		// ── Resolve final commit message ─────────────────────────────────────────

		let finalMessage = commit.message;

		if (action === "e") {
			finalMessage = await input({
				message: "Edit commit message:",
				default: commit.message,
				validate: (v) =>
					v.trim().length > 0 ? true : "Commit message cannot be empty",
			});
		}

		// ── Execute commit ───────────────────────────────────────────────────────

		if (!dryRun) {
			const commitSpin = spinner(
				`Staging ${eligibleFiles.length} file(s) and committing…`,
			);
			try {
				// 1. Unstage everything in the index
				await unstageAll(cwd);

				// 2. Stage only the files for this specific commit
				await stageFiles(eligibleFiles, cwd);

				// 3. Commit
				const sha = await createCommit(finalMessage, cwd);

				commitSpin.stop();
				printCommitSuccess(commit.id, sha, finalMessage);
			} catch (err) {
				commitSpin.fail(`Commit #${commit.id} failed`);
				throw err;
			}
		} else {
			// Dry-run mode: just print what would happen
			console.log(c.muted(`  [dry-run] would commit: `) + c.bold(finalMessage));
			console.log(c.muted(`  [dry-run] files: `) + eligibleFiles.join(", "));
		}

		applied++;
		for (const f of eligibleFiles) committedFiles.add(f);
	}

	// ── Step 5: Cleanup & Restore ─────────────────────────────────────────────

	printHeader("Step 5 · Cleanup");

	// Files that were originally staged but were skipped should be re-staged
	const filesToRestore = originalStagedFiles.filter(
		(f) => !committedFiles.has(f),
	);

	if (filesToRestore.length > 0 && !dryRun) {
		const restoreSpin = spinner(
			`Re-staging ${filesToRestore.length} skipped file(s)…`,
		);
		try {
			// Unstage everything first (some may be partially staged from a failed run)
			await unstageAll(cwd);
			// Re-stage the skipped files so they're back where the user left them
			await stageFiles(filesToRestore, cwd);
			restoreSpin.succeed(
				`Restored ${filesToRestore.length} skipped file(s) to the staging area`,
			);
		} catch (err) {
			restoreSpin.warn(
				"Could not fully restore staged files — check `git status`",
			);
			// Non-fatal: log and continue
			console.error(err.message);
		}
	} else {
		console.log(
			c.success("  ✔ Working directory is clean — nothing to restore"),
		);
	}

	// ── Final summary ─────────────────────────────────────────────────────────

	printFinalSummary(applied, skipped);

	if (!dryRun && applied > 0) {
		await runPostCommitFollowUps(config, cwd, plan, currentProjectMemory);
	}
}

// ─── UserError (safe to print without stack trace) ───────────────────────────

export class UserError extends Error {
	constructor(msg) {
		super(msg);
		this.name = "UserError";
	}
}
