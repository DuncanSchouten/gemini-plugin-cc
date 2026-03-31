# Gemini plugin for Claude Code

Use Gemini from inside Claude Code for code reviews or to delegate tasks to Gemini.

This plugin is for Claude Code users who want an easy way to start using Gemini from the workflow
they already have.

## What You Get

- `/gemini:review` for a balanced read-only Gemini review
- `/gemini:adversarial-review` for a steerable challenge review
- `/gemini:rescue`, `/gemini:status`, `/gemini:result`, and `/gemini:cancel` to delegate work and manage background jobs

## Requirements

- **Google account with Gemini CLI access**
- **Node.js 18.18 or later**

## Install

### 1. Add the marketplace and install the plugin

In Claude Code, run these two commands:

```bash
/plugin marketplace add DuncanSchouten/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
```

### 2. Run setup

```bash
/gemini:setup
```

`/gemini:setup` will tell you whether the Gemini CLI is ready. If Gemini is missing and npm is available, it can offer to install the Gemini CLI for you.

If you prefer to install the Gemini CLI yourself, use:

```bash
npm install -g @google/gemini-cli
```

### 3. Authenticate (if needed)

If the Gemini CLI is installed but not authenticated yet, run:

```bash
!gemini auth login
```

### Verify

After install, you should see:

- the slash commands listed below
- the `gemini:gemini-rescue` subagent in `/agents`

One simple first run is:

```bash
/gemini:review --background
/gemini:status
/gemini:result
```

## Usage

### `/gemini:review`

Runs a balanced Gemini review on your current work.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. Use [`/gemini:adversarial-review`](#geminiadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/gemini:review
/gemini:review --base main
/gemini:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/gemini:status`](#geministatus) to check on the progress and [`/gemini:cancel`](#geminicancel) to cancel the ongoing task.

### `/gemini:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/gemini:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/gemini:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/gemini:adversarial-review
/gemini:adversarial-review --base main challenge whether this was the right caching and retry design
/gemini:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/gemini:rescue`

Hands a task to Gemini through the `gemini:gemini-rescue` subagent.

Use it when you want Gemini to:

- investigate a bug
- try a fix
- continue a previous Gemini session
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repo.

Examples:

```bash
/gemini:rescue investigate why the tests started failing
/gemini:rescue fix the failing test with the smallest safe patch
/gemini:rescue --resume apply the top fix from the last run
/gemini:rescue --model pro investigate the flaky integration test
/gemini:rescue --model flash fix the issue quickly
/gemini:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Gemini:

```text
Ask Gemini to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, Gemini CLI uses its default model routing
- model aliases: `flash` maps to `gemini-3-flash-preview`, `pro` maps to `gemini-3-pro-preview`, `pro-latest` maps to `gemini-3.1-pro-preview`
- follow-up rescue requests can continue the latest Gemini session in the repo

### `/gemini:status`

Shows running and recent Gemini jobs for the current repository.

Examples:

```bash
/gemini:status
/gemini:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/gemini:result`

Shows the final stored Gemini output for a finished job.

Examples:

```bash
/gemini:result
/gemini:result task-abc123
```

### `/gemini:cancel`

Cancels an active background Gemini job.

Examples:

```bash
/gemini:cancel
/gemini:cancel task-abc123
```

### `/gemini:setup`

Checks whether the Gemini CLI is installed and authenticated.
If the Gemini CLI is missing and npm is available, it will offer to install it for you.

You can also use `/gemini:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/gemini:setup --enable-review-gate
/gemini:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Gemini review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Gemini loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/gemini:review
```

### Hand A Problem To Gemini

```bash
/gemini:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/gemini:adversarial-review --background
/gemini:rescue --background investigate the flaky test
```

Then check in with:

```bash
/gemini:status
/gemini:result
```

## Gemini Integration

The Gemini plugin spawns the [Gemini CLI](https://github.com/google-gemini/gemini-cli) as a subprocess with `--output-format stream-json` for structured NDJSON output. It uses the global `gemini` binary installed in your environment and inherits your existing authentication from `~/.gemini/settings.json`.

### Authentication

The plugin uses your existing Gemini CLI authentication (OAuth via Google account). Run `gemini auth login` if you haven't authenticated yet.

### Model Selection

You can specify a model with `--model`:

- `flash` — maps to `gemini-3-flash-preview` (fast, lightweight)
- `pro` — maps to `gemini-3-pro-preview` (capable, thinking-enabled)
- `pro-latest` — maps to `gemini-3.1-pro-preview` (latest pro with multimodal tool use)
- Or pass any model name directly (e.g., `--model gemini-2.5-pro`)

If you omit `--model`, the Gemini CLI uses its default model routing.

### Session Resume

Gemini CLI automatically saves conversation sessions. When you run `/gemini:rescue`, the plugin captures the session ID and stores it with the job record. You can resume a previous session with `--resume` to continue where you left off with full conversation context.

## FAQ

### Do I need a separate Gemini account for this plugin?

If you are already signed into the Gemini CLI on this machine, that account should work immediately. This plugin uses your local Gemini CLI authentication.

If you only use Claude Code today and have not used the Gemini CLI yet, you will need to authenticate with your Google account. Run `/gemini:setup` to check whether Gemini is ready, and use `!gemini auth login` if it is not.

### Does the plugin use a separate Gemini runtime?

No. This plugin spawns the [Gemini CLI](https://github.com/google-gemini/gemini-cli) directly as a subprocess on the same machine.

That means:

- it uses the same Gemini CLI install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment
- each command spawns a fresh process (no persistent background server)

## Acknowledgments

This plugin is based on the [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) by OpenAI, originally built to integrate OpenAI's Codex CLI into Claude Code. This project adapts that architecture to use Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli) instead, replacing the Codex App Server protocol with direct Gemini subprocess invocation.

The original plugin's design — job lifecycle management, review gate hooks, prompt templating, and the companion script architecture — provided the foundation for this work. Licensed under [Apache 2.0](./LICENSE).
