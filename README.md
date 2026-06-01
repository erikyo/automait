# Automit 🤖

> AI-powered Git commit planning workflow automation using a local [Ollama](https://ollama.com) model.

`automit` analyzes your staged changes, proposes a semantically grouped commit plan that follows the [Conventional Commits](https://www.conventionalcommits.org/) specification, and walks you through applying each commit interactively — all without sending your code to the cloud.

---

## Features

- **Zero cloud dependency** — runs entirely on your machine via Ollama.
- **Smart grouping** — the AI proposes logically related file groups as separate commits.
- **Controlled Commit Count** — Specify a desired total number of commits (`--commit`), and automit will intelligently adjust the proposed plan to meet that target.
- **Interactive workflow** — apply, edit, or skip each commit one by one.
- **Fully configurable** — CLI flags, environment variables, or a `.automitrc.json` file.
- **Safe restore** — skipped files are always re-staged exactly as they were.
- **Post-commit follow-ups** — optionally update README, update CHANGELOG, or generate a PR message after commits.
- **Beautiful output** — spinners, colours, and boxed summaries.

---

## Quick Start

```bash
# Stage some files
git add src/auth.js src/middleware.js

# Run automit
npx automit
```

That's it. automit will:

1. Detect the staged diff.
2. Ask Ollama to analyse it and propose a commit plan.
3. Print the plan in your terminal.
4. Walk you through each proposed commit interactively.
5. Offer optional README, CHANGELOG, and pull request message follow-ups.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18.0.0 |
| npm | ≥ 9 |
| [Ollama](https://ollama.com/download) | latest |
| Git | ≥ 2.x |

### Install & start Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model (gemma4 is the default)
ollama pull gemma4

# Or use llama3 for general use
ollama pull llama3

# Start the server (usually auto-started as a service)
ollama serve
```

---

## Installation

### Global install (recommended)

```bash
npm install -g automit
```

After installation the `automit` binary is available system-wide.

### Local development

```bash
git clone https://github.com/your-org/automit.git
cd automit
npm install
npm link          # makes `automit` available globally from this checkout
```

---

## Usage

```
automit [options]

Options:
  -e, --endpoint <url>        Ollama base URL (default: http://localhost:11434)
  -m, --model <name>          Ollama model identifier (default: gemma4)
  -p, --system-prompt <str>   Override the system prompt for commit generation
  -d, --dry-run               Analyse and plan only — do not execute any git commands
      --commit <count>        Enforce a preferred total number of commits (Alias: --commits)
      --cwd <path>            Run as if automit were started in this directory
  -v, --version               Print version and exit
  -h, --help                  Show help
```

### Examples

```bash
# Use a different model
automit --model llama3

# Dry run (plan only, no commits)
automit --dry-run

# Ask for exactly six total commits
automit --commit 6
```
