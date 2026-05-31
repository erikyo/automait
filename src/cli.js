#!/usr/bin/env node
/**
 * cli.js  —  automait entry point
 *
 * Usage:
 *   automait [options]
 *
 * Options:
 *   -e, --endpoint <url>       Ollama base URL (default: http://localhost:11434)
 *   -m, --model <name>         Ollama model (default: gemma4)
 *   -p, --system-prompt <str>  Override the system prompt
 *   -d, --dry-run              Plan only — do not execute any git commands
 *   --commit <count>           Preferred total number of commits
 *   -v, --version              Print version and exit
 *   -h, --help                 Show help
 */

import { InvalidArgumentError, program } from 'commander';
import { createRequire } from 'module';
import { resolve } from 'path';

import { resolveConfig } from './config.js';
import { runWorkflow, UserError } from './workflow.js';
import { isGitRepo } from './git.js';
import { printError, printWarning, c } from './ui.js';

// ─── Read package.json for version ───────────────────────────────────────────

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

function parseCommitCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return count;
}

// ─── CLI definition ───────────────────────────────────────────────────────────

program
  .name('automait')
  .description('AI-powered Git commit workflow using a local Ollama model')
  .version(pkg.version, '-v, --version')
  .option('-e, --endpoint <url>',         'Ollama base URL')
  .option('-m, --model <name>',           'Ollama model identifier')
  .option('-p, --system-prompt <string>', 'Override the system prompt for commit generation')
  .option('-d, --dry-run',                'Analyse and plan only — do not run any git commands', false)
  .option('--commit <count>',             'Preferred total number of commits', parseCommitCount)
  .option('--commits <count>',            'Alias for --commit', parseCommitCount)
  .option('--cwd <path>',                 'Run as if automait were started in this directory')
  .addHelpText(
    'after',
    `
${c.bold('Configuration')}
  automait reads config from (lowest → highest priority):
    1. ${c.muted('.automaitrc.json')} in the project root
    2. Environment variables: ${c.muted('AUTOMIT_ENDPOINT')}, ${c.muted('AUTOMIT_MODEL')}, ${c.muted('AUTOMIT_SYSTEM_PROMPT')}
    3. CLI flags (above)

${c.bold('Examples')}
  ${c.muted('$')} automait
  ${c.muted('$')} automait --commit 6
  ${c.muted('$')} automait --model llama3 --dry-run
  ${c.muted('$')} AUTOMIT_MODEL=mistral automait
`
  );

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  program.parse();
  const flags = program.opts();

  // Resolve the working directory
  const cwd = flags.cwd ? resolve(flags.cwd) : process.cwd();

  // Verify we're inside a Git repository
  if (!(await isGitRepo(cwd))) {
    printError(
      `${cwd} is not inside a Git repository.\n` +
      '  Create one first, then stage the changes you want automait to plan:\n' +
      '    git init\n' +
      '    git add <files>\n' +
      '    automait'
    );
    process.exit(1);
  }

  // Merge all config sources
  const config = await resolveConfig(flags);

  if (flags.dryRun) {
    printWarning('Dry-run mode enabled — no git commands will be executed.\n');
  }

  // Print active config in verbose mode (always show for transparency)
  console.log(
    c.muted(`  Using model: ${config.model}  |  endpoint: ${config.ollamaEndpoint}\n`)
  );

  try {
    await runWorkflow(config, {
      dryRun: flags.dryRun,
      cwd,
      targetCommitCount: flags.commit ?? flags.commits,
    });
  } catch (err) {
    if (err instanceof UserError) {
      // Expected user-facing errors (no staged files, etc.)
      printError(err.message);
      process.exit(1);
    }

    // Unexpected errors — print with stack in dev, clean message in prod
    const isDev = process.env.NODE_ENV === 'development';
    printError(isDev ? err.stack : err.message);
    process.exit(1);
  }
}

main();
