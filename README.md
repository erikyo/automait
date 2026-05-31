# automait 🤖

> AI-powered Git commit workflow automation using a local [Ollama](https://ollama.com) model.

`automait` analyses your staged changes, proposes a semantically grouped commit plan that follows the [Conventional Commits](https://www.conventionalcommits.org/) specification, and walks you through applying each commit interactively — all without sending your code to the cloud.

---

## Features

- **Zero cloud dependency** — runs entirely on your machine via Ollama.
- **Smart grouping** — the AI proposes logically related file groups as separate commits.
- **Interactive workflow** — apply, edit, or skip each commit one by one.
- **Fully configurable** — CLI flags, environment variables, or a `.automaitrc.json` file.
- **Safe restore** — skipped files are always re-staged exactly as they were.
- **Post-commit follow-ups** — optionally update README, update CHANGELOG, or generate a PR message after commits.
- **Beautiful output** — spinners, colours, and boxed summaries.

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
npm install -g automait
```

After installation the `automait` binary is available system-wide.

### Local development

```bash
git clone https://github.com/your-org/automait.git
cd automait
npm install
npm link          # makes `automait` available globally from this checkout
```

---

## Quick Start

```bash
# Stage some files
git add src/auth.js src/middleware.js

# Run automait
automait
```

That's it. automait will:

1. Detect the staged diff.
2. Ask Ollama to analyse it and propose a commit plan.
3. Print the plan in your terminal.
4. Walk you through each proposed commit interactively.
5. Offer optional README, CHANGELOG, and pull request message follow-ups.

---

## Usage

```
automait [options]

Options:
  -e, --endpoint <url>        Ollama base URL (default: http://localhost:11434)
  -m, --model <name>          Ollama model identifier (default: gemma4)
  -p, --system-prompt <str>   Override the system prompt for commit generation
  -d, --dry-run               Analyse and plan only — do not execute any git commands
      --cwd <path>            Run as if automait were started in this directory
  -v, --version               Print version and exit
  -h, --help                  Show help
```

### Examples

```bash
# Use a different model
automait --model llama3

# Dry run (plan only, no commits)
automait --dry-run

# Point to a remote Ollama instance
automait --endpoint http://192.168.1.10:11434

# Override the system prompt inline
automait --system-prompt "Write a one-line commit message, imperative, no punctuation."

# Run from a different directory
automait --cwd /path/to/repo
```

---

## Configuration

Configuration is loaded from three sources, merged in this priority order (highest wins):

| Priority | Source | Example |
|---|---|---|
| 3 (highest) | CLI flags | `--model llama3` |
| 2 | Environment variables | `AUTOMIT_MODEL=llama3` |
| 1 | Config file | `.automaitrc.json` |

### Config file

Copy the example file and edit it:

```bash
cp .automaitrc.json.example .automaitrc.json
```

```json
{
  "ollamaEndpoint": "http://localhost:11434",
  "model": "gemma4",
  "timeoutMs": 120000,
  "systemPrompt": "..."
}
```

automait also reads config from `automait.config.js` or from an `"automait"` key inside `package.json` (powered by [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)).

### Environment variables

| Variable | Description |
|---|---|
| `AUTOMIT_ENDPOINT` | Ollama base URL |
| `AUTOMIT_MODEL` | Model identifier |
| `AUTOMIT_SYSTEM_PROMPT` | Full system prompt override |
| `AUTOMIT_TIMEOUT_MS` | HTTP timeout in milliseconds |

---

## Workflow Details

### Step 1 — Staging Detection

Runs `git diff --cached` to collect all staged files and their diffs. Exits with a clear error if nothing is staged.

### Step 2 — AI Planning

Sends the full diff to Ollama with a structured JSON-schema prompt. The model returns a plan like:

```json
{
  "summary": "Add JWT authentication and update middleware",
  "commits": [
    {
      "id": 1,
      "message": "feat(auth): add jwt token generation and validation",
      "files": ["src/auth.js"],
      "rationale": "Core auth logic is independent of middleware wiring"
    },
    {
      "id": 2,
      "message": "chore(middleware): wire jwt auth into express middleware",
      "files": ["src/middleware.js"],
      "rationale": "Integration layer that depends on the auth module"
    }
  ]
}
```

### Step 3 — Plan Presentation

Clears the terminal and renders a formatted summary showing:
- Overall change summary
- Number of proposed commits
- Per-commit: files, message, and rationale

### Step 4 — Interactive Committing

For each proposed commit you are prompted:

```
? Commit #1  feat(auth): add jwt token generation and validation
  Files: src/auth.js
❯ Apply
  Edit message
  Skip
```

- **Apply** — unstages everything, re-stages only the files for this commit, then runs `git commit`.
- **Edit message** — opens an inline prompt to modify the message before committing.
- **Skip** — moves to the next commit without touching the index.

You can also choose **Apply all automatically** at the plan-review stage to skip the per-commit prompts.

### Step 5 — Cleanup & Restore

After the loop, any files from the original staged set that were skipped are re-staged automatically, leaving the working directory in a predictable state.

### Step 6 — Follow-up Docs

After at least one commit is applied, automait asks whether you need to update `README.md`, update `CHANGELOG.md`, or generate a pull request message. README and changelog updates are written with Ollama and staged for your next commit; the pull request message is printed in the terminal.

---

## Architecture

```
automait/
├── src/
│   ├── cli.js        # Entry point, commander setup, error handling
│   ├── config.js     # Config resolution (file → env → flags)
│   ├── git.js        # Git operations via simple-git
│   ├── ollama.js     # Ollama API client + commit plan generation
│   ├── ui.js         # Terminal output: chalk, boxen, ora
│   └── workflow.js   # 5-step workflow orchestrator
├── .automaitrc.json.example
├── .gitignore
├── package.json
└── README.md
```

---

## Supported Models

Any model available in your Ollama instance works. Recommended models:

| Model                | Pull command                 | Notes                      |
|----------------------|------------------------------|----------------------------|
| `gemma4` *(default)* | `ollama pull gemma4`         | Surprisingly capable model |
| `qwen2.5-coder`      | `ollama pull qwen2.5-coder`  | Excellent for code diffs   |
| `deepseek-coder`     | `ollama pull deepseek-coder` | Strong code understanding  |
| `mistral`            | `ollama pull mistral`        | Fast and capable           |
| `llama3`             | `ollama pull llama3`         | Great general purpose      |
| `codellama`          | `ollama pull codellama`      | Good for code-heavy repos  |

---

## Troubleshooting

**`Cannot reach Ollama at http://localhost:11434`**
→ Make sure Ollama is running: `ollama serve`

**`No staged changes detected`**
→ You need to `git add` files before running automait.

**`Ollama returned non-JSON response`**
→ The model may not follow structured output well. Try a more capable model with `--model llama3` or `--model qwen2.5-coder`.

**Timeout errors**
→ Large diffs may take longer. Increase the timeout: `AUTOMIT_TIMEOUT_MS=240000 automait`

---

## License

MIT
