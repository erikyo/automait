/**
 * ui.js
 * All terminal output helpers: colors, spinners, boxes, and formatted sections.
 * Centralised here so the rest of the codebase stays clean.
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';

// ─── Palette ──────────────────────────────────────────────────────────────────

export const c = {
  // Brand
  primary:  chalk.hex('#7C3AED'),   // violet
  accent:   chalk.hex('#06B6D4'),   // cyan
  // Semantic
  success:  chalk.green,
  warning:  chalk.yellow,
  error:    chalk.red,
  muted:    chalk.gray,
  bold:     chalk.bold,
  // Commit type colours
  type: (t) => {
    const map = {
      feat:     chalk.green,
      fix:      chalk.red,
      chore:    chalk.gray,
      docs:     chalk.blue,
      refactor: chalk.magenta,
      test:     chalk.yellow,
      build:    chalk.cyan,
    };
    const type = t?.split('(')[0]?.split(':')[0]?.trim();
    return (map[type] ?? chalk.white)(t);
  },
};

// ─── Spinner factory ──────────────────────────────────────────────────────────

/**
 * Creates and starts an ora spinner.
 * @param {string} text
 * @returns {import('ora').Ora}
 */
export function spinner(text) {
  return ora({ text, color: 'cyan', spinner: 'dots' }).start();
}

// ─── Section headers ──────────────────────────────────────────────────────────

export function printHeader(title) {
  const line = c.primary('─'.repeat(60));
  console.log(`\n${line}`);
  console.log(c.primary.bold(`  ${title}`));
  console.log(`${line}\n`);
}

export function printStep(n, total, label) {
  console.log(
    c.muted(`Step ${n}/${total}`) + '  ' + c.bold(label)
  );
}

// ─── Plan summary box ─────────────────────────────────────────────────────────

/**
 * Renders the AI-generated commit plan as a beautiful terminal report.
 *
 * @param {import('./ollama.js').CommitPlan} plan
 */
export function printPlan(plan) {
  process.stdout.write('\x1Bc'); // clear terminal (cross-platform)

  console.log(
    boxen(
      c.primary.bold(' automait — AI Commit Plan ') +
        '\n' +
        c.muted(`  Powered by Ollama`),
      {
        padding: 1,
        borderColor: 'magenta',
        borderStyle: 'round',
        textAlignment: 'center',
      }
    )
  );

  // Overall summary
  console.log(
    boxen(c.accent.bold('Summary\n\n') + chalk.white(plan.summary), {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: 'single',
      borderColor: 'cyan',
    })
  );
  console.log();

  if (plan.reasoningTrace) {
    console.log(
      boxen(c.primary.bold('AI reasoning trace\n\n') + chalk.white(plan.reasoningTrace), {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: 'single',
        borderColor: 'magenta',
      })
    );
    console.log();
  }

  // Per-commit breakdown
  console.log(
    c.bold(`  ${plan.commits.length} proposed commit${plan.commits.length !== 1 ? 's' : ''}:\n`)
  );

  for (const commit of plan.commits) {
    // Commit header line
    const badge = c.primary.bold(` #${commit.id} `);
    const msg   = c.type(commit.message);
    console.log(`  ${badge}  ${msg}`);

    // Files list
    for (const f of commit.files) {
      console.log(`       ${c.muted('•')} ${chalk.cyan(f)}`);
    }

    // Rationale (muted, indented)
    if (commit.rationale) {
      console.log(`       ${c.muted('↳ ' + commit.rationale)}`);
    }
    console.log();
  }
}

// ─── Commit result line ───────────────────────────────────────────────────────

export function printCommitSuccess(id, sha, message) {
  console.log(
    c.success('  ✔') +
      c.muted(` [${sha}]`) +
      `  ${c.bold(`#${id}`)} ${message}`
  );
}

export function printCommitSkipped(id) {
  console.log(c.warning(`  ⊘  #${id} skipped`));
}

// ─── Final summary ────────────────────────────────────────────────────────────

export function printFinalSummary(applied, skipped) {
  const lines = [
    c.success.bold('Done!'),
    '',
    `  ${c.success('✔')} Applied: ${c.bold(applied)}`,
    `  ${c.warning('⊘')} Skipped: ${c.bold(skipped)}`,
  ].join('\n');

  console.log(
    '\n' +
      boxen(lines, {
        padding: 1,
        borderStyle: 'round',
        borderColor: 'green',
      })
  );
}

// ─── Error helpers ────────────────────────────────────────────────────────────

export function printError(msg) {
  console.error('\n' + c.error.bold('  ✖ Error: ') + chalk.white(msg) + '\n');
}

export function printWarning(msg) {
  console.warn(c.warning('  ⚠  ') + msg);
}
