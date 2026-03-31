# Gemini Plugin for Claude Code - Requirements

## Overview

A Claude Code plugin that integrates Google's Gemini CLI as a secondary AI coding assistant. The plugin enables Claude Code users to delegate code reviews, debugging, investigation, and implementation tasks to Gemini while staying within their existing Claude Code workflow.

This is a migration from an OpenAI Codex-based plugin to Google Gemini CLI. The migration replaces the Codex App Server broker protocol (JSON-RPC over Unix sockets) with direct subprocess invocation of the `gemini` CLI binary, simplifying the architecture while preserving all user-facing capabilities.

## User Stories

### US-001: Setup Check
**As a** Claude Code user
**I want to** verify my Gemini CLI is installed and authenticated
**So that** I can use Gemini-powered features without guessing whether my environment is ready

**Acceptance Criteria:**
WHEN user runs `/gemini:setup`
THE SYSTEM SHALL check for the `gemini` binary on PATH and report availability

WHEN `gemini` is available
THE SYSTEM SHALL check `~/.gemini/settings.json` for a valid `selectedType` and report authentication status

WHEN user passes `--enable-review-gate` or `--disable-review-gate`
THE SYSTEM SHALL toggle the stop-time review gate configuration

### US-002: Code Review
**As a** Claude Code user
**I want to** run an automated code review of my uncommitted changes or branch diff
**So that** I can get a second opinion on my code before committing or shipping

**Acceptance Criteria:**
WHEN user runs `/gemini:review`
THE SYSTEM SHALL identify reviewable changes from git state (working tree or branch diff)

WHEN reviewable changes exist
THE SYSTEM SHALL send them to Gemini CLI with a balanced review prompt and return structured findings

WHEN user specifies `--base <ref>`
THE SYSTEM SHALL review the diff between the specified base and HEAD

WHEN user specifies `--wait`
THE SYSTEM SHALL run the review in the foreground and block until complete

WHEN user specifies `--background`
THE SYSTEM SHALL run the review as a background job and return immediately

### US-003: Adversarial Review
**As a** Claude Code user
**I want to** run a challenge review that questions my implementation approach and design choices
**So that** I can identify risks, assumptions, and failure modes before shipping

**Acceptance Criteria:**
WHEN user runs `/gemini:adversarial-review`
THE SYSTEM SHALL send changes to Gemini with an adversarial review prompt focused on breaking confidence in the change

WHEN user supplies focus text
THE SYSTEM SHALL weight the review toward the specified focus area

WHEN review completes
THE SYSTEM SHALL return structured JSON output with verdict, findings (severity, file, line range, confidence, recommendation), and next steps

### US-004: Task Delegation (Rescue)
**As a** Claude Code user
**I want to** delegate investigation, fix requests, or follow-up work to Gemini
**So that** I can offload substantial coding tasks while continuing my own work

**Acceptance Criteria:**
WHEN user runs `/gemini:rescue "task description"`
THE SYSTEM SHALL invoke Gemini CLI with the task prompt and agentic capabilities (file editing, shell commands)

WHEN user specifies `--background`
THE SYSTEM SHALL run the task as a detached background process

WHEN user specifies `--model <model>`
THE SYSTEM SHALL pass the model selection to Gemini CLI

WHEN task completes
THE SYSTEM SHALL store the result for retrieval via `/gemini:result`

### US-005: Job Status
**As a** Claude Code user
**I want to** check the status of active and recent Gemini jobs
**So that** I can monitor background work and know when results are ready

**Acceptance Criteria:**
WHEN user runs `/gemini:status`
THE SYSTEM SHALL display a summary of all jobs for the current workspace session

WHEN user runs `/gemini:status <job-id>`
THE SYSTEM SHALL display detailed status for the specified job

### US-006: Job Result
**As a** Claude Code user
**I want to** retrieve the stored output of a completed Gemini job
**So that** I can review findings and act on them

**Acceptance Criteria:**
WHEN user runs `/gemini:result`
THE SYSTEM SHALL display the full output of the most recent completed job

WHEN user runs `/gemini:result <job-id>`
THE SYSTEM SHALL display the full output of the specified job

WHEN the specified job has not completed
THE SYSTEM SHALL inform the user of the current status and suggest `/gemini:status`

### US-007: Job Cancel
**As a** Claude Code user
**I want to** cancel an active background Gemini job
**So that** I can stop work that is no longer needed

**Acceptance Criteria:**
WHEN user runs `/gemini:cancel`
THE SYSTEM SHALL terminate the most recent active job's Gemini subprocess

WHEN user runs `/gemini:cancel <job-id>`
THE SYSTEM SHALL terminate the specified job's subprocess

WHEN cancellation succeeds
THE SYSTEM SHALL update the job status to `cancelled` and report confirmation

### US-008: Stop Review Gate
**As a** Claude Code user
**I want to** optionally have Gemini review my work before ending a Claude Code session
**So that** I get a final safety check on code changes before walking away

**Acceptance Criteria:**
WHEN stop review gate is enabled AND user ends a Claude Code session
THE SYSTEM SHALL run a targeted Gemini review of the last Claude turn's code changes

WHEN review finds blocking issues
THE SYSTEM SHALL prevent session exit and report the issues

WHEN the previous turn made no code changes
THE SYSTEM SHALL allow session exit immediately without invoking Gemini

## Functional Requirements

### FR-001: Gemini CLI Subprocess Invocation
**Priority:** P0
**Persona:** All users

WHEN a review or task is requested
THE SYSTEM SHALL spawn `gemini` as a child process with `-p "<prompt>" --output-format stream-json`

WHEN sandbox mode is appropriate (reviews, read-only tasks)
THE SYSTEM SHALL include the `--sandbox` flag

WHEN write operations are expected (rescue tasks)
THE SYSTEM SHALL use `--approval-mode auto_edit`

WHEN only read operations are expected (reviews)
THE SYSTEM SHALL use `--approval-mode yolo`

WHEN a model is specified
THE SYSTEM SHALL pass it via `-m <model>`

**Rationale:** Direct subprocess invocation replaces the Codex App Server broker protocol, eliminating the broker multiplexer, JSON-RPC client, and Unix socket communication layer.

### FR-002: NDJSON Stream Parsing
**Priority:** P0
**Persona:** All users

WHEN Gemini CLI outputs newline-delimited JSON events to stdout
THE SYSTEM SHALL parse each line as a JSON object

WHEN an event of type `message` is received
THE SYSTEM SHALL capture the content as the latest agent message

WHEN an event of type `tool_use` is received
THE SYSTEM SHALL log the tool name for progress reporting

WHEN an event of type `result` is received
THE SYSTEM SHALL capture it as the final result

WHEN a malformed JSON line is encountered
THE SYSTEM SHALL log a warning and skip the line without crashing

**Rationale:** NDJSON streaming replaces the JSON-RPC notification stream from the Codex App Server.

### FR-003: Review Prompt Construction
**Priority:** P0
**Persona:** Users running `/gemini:review` or `/gemini:adversarial-review`

WHEN a standard review is requested
THE SYSTEM SHALL construct a balanced review prompt from the `prompts/review.md` template

WHEN an adversarial review is requested
THE SYSTEM SHALL construct an adversarial review prompt from the `prompts/adversarial-review.md` template

WHEN a review output schema is required
THE SYSTEM SHALL embed the JSON schema from `schemas/review-output.schema.json` in the prompt text with instructions to return only valid JSON matching the schema

WHEN review output is received
THE SYSTEM SHALL attempt to parse structured JSON output from the Gemini response

**Rationale:** Gemini CLI has no native review endpoint. Both review types use prompt-based construction with the same underlying subprocess invocation.

### FR-004: Task Delegation and Background Execution
**Priority:** P0
**Persona:** Users running `/gemini:rescue`

WHEN a task is requested in foreground mode
THE SYSTEM SHALL spawn Gemini and wait for completion, streaming progress

WHEN a task is requested in background mode
THE SYSTEM SHALL spawn a detached worker process that manages the Gemini subprocess

WHEN a background task completes
THE SYSTEM SHALL persist the full output to the job state file

WHEN a background task is running
THE SYSTEM SHALL write progress updates to a log file accessible via `/gemini:status`

**Rationale:** Background execution allows users to continue working in Claude Code while Gemini processes long-running tasks.

### FR-005: Job Lifecycle Management
**Priority:** P0
**Persona:** All users

WHEN a new job is created
THE SYSTEM SHALL assign a unique ID (`job-<timestamp>-<random>`) and persist it to workspace state

WHEN a job transitions status (queued, running, completed, failed, cancelled)
THE SYSTEM SHALL update the persisted state with the new status and timestamp

THE SYSTEM SHALL retain a maximum of 50 jobs per workspace

WHEN a Claude Code session ends
THE SYSTEM SHALL cancel any running jobs associated with that session

**Rationale:** Job lifecycle management enables the status, result, and cancel commands.

### FR-006: Auth and Availability Detection
**Priority:** P0
**Persona:** Users running `/gemini:setup`

WHEN checking availability
THE SYSTEM SHALL verify the `gemini` binary exists on PATH

WHEN checking authentication
THE SYSTEM SHALL read `~/.gemini/settings.json` and verify the `selectedType` field is present

WHEN Gemini is unavailable
THE SYSTEM SHALL provide installation guidance for the Gemini CLI

WHEN Gemini is not authenticated
THE SYSTEM SHALL provide guidance to run `gemini auth login`

**Rationale:** Users need clear feedback about their environment before attempting to use Gemini features.

### FR-007: Model Selection and Aliases
**Priority:** P0
**Persona:** Users specifying `--model`

THE SYSTEM SHALL support these model aliases:
- `flash` resolves to `gemini-3-flash-preview`
- `pro` resolves to `gemini-3-pro-preview`
- `pro-latest` resolves to `gemini-3.1-pro-preview`
- `auto` uses Gemini CLI's built-in model routing (default)

WHEN no model is specified
THE SYSTEM SHALL omit the `-m` flag, letting Gemini CLI use its default routing

WHEN an unrecognized model string is provided
THE SYSTEM SHALL pass it through directly to Gemini CLI via `-m`

**Rationale:** Model aliases provide user-friendly shortcuts while allowing direct model specification for advanced users.

### FR-008: Stop Review Gate
**Priority:** P1
**Persona:** Users with review gate enabled

WHEN the stop review gate is enabled AND a Claude Code session stop event fires
THE SYSTEM SHALL invoke Gemini with the stop-review-gate prompt to review the last Claude turn

WHEN Gemini responds with `BLOCK: <reason>`
THE SYSTEM SHALL prevent session exit and report the blocking reason

WHEN Gemini responds with `ALLOW: <reason>`
THE SYSTEM SHALL permit session exit

WHEN the previous Claude turn did not produce code changes
THE SYSTEM SHALL allow session exit immediately without invoking Gemini

WHEN Gemini is not authenticated or unavailable
THE SYSTEM SHALL allow session exit and emit a warning

**Rationale:** The review gate provides an optional safety net that catches issues before a user walks away from a coding session.

## Non-Functional Requirements

### NFR-001: Process Timeout
THE SYSTEM SHALL terminate Gemini subprocesses that exceed a configurable timeout (default: 15 minutes for reviews, 30 minutes for tasks)

### NFR-002: Error Resilience
WHEN the Gemini subprocess exits with a non-zero status
THE SYSTEM SHALL capture stderr, report the error to the user, and update job status to `failed`

WHEN structured JSON output cannot be parsed from Gemini's response
THE SYSTEM SHALL fall back to returning the raw text output

### NFR-003: Process Cleanup
WHEN a job is cancelled
THE SYSTEM SHALL send SIGTERM to the Gemini subprocess and its process tree

WHEN a Claude Code session ends
THE SYSTEM SHALL terminate all Gemini subprocesses associated with that session

### NFR-004: Startup Latency
THE SYSTEM SHALL not require any persistent background processes (no broker, no app server)

## Data Requirements

### DR-001: Job State
THE SYSTEM SHALL store job records in `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash>/`
THE SYSTEM SHALL retain a maximum of 50 job records per workspace
THE SYSTEM SHALL store full job output in individual `<jobId>.json` files
THE SYSTEM SHALL store job logs in `<jobId>.log` files

## Integration Requirements

### IR-001: Gemini CLI Binary
THE SYSTEM SHALL integrate with the `gemini` CLI binary installed globally via `npm install -g @google/gemini-cli`
WHEN spawning Gemini
THE SYSTEM SHALL inherit the user's existing Gemini authentication from `~/.gemini/settings.json`

### IR-002: Claude Code Plugin System
THE SYSTEM SHALL register as a Claude Code plugin via `.claude-plugin/plugin.json`
THE SYSTEM SHALL expose 7 slash commands under the `/gemini:` namespace
THE SYSTEM SHALL register lifecycle hooks for SessionStart, SessionEnd, and Stop events

### IR-003: Git Integration
WHEN identifying reviewable changes
THE SYSTEM SHALL use git to determine working tree state, staged/unstaged diffs, and branch diffs
THE SYSTEM SHALL support `--base <ref>` for specifying the diff base
THE SYSTEM SHALL support `--scope auto|working-tree|branch` for controlling review scope

## Constraints

- Each Gemini CLI invocation is stateless; there is no thread or conversation resumption across invocations
- Gemini CLI has no native review endpoint; all reviews use prompt-based construction
- Structured output (JSON schema compliance) is enforced via prompt instructions, not a native API parameter
- The plugin depends on the `gemini` CLI binary being installed and authenticated independently

## Out of Scope

- AI SDK provider integration (`ai-sdk-provider-gemini-cli-agentic`) -- reserved for potential future migration
- Direct Gemini API usage (`@google/generative-ai` SDK) -- bypasses CLI agentic capabilities
- Thread/conversation resumption -- Gemini CLI does not support persistent threads
- Staged-only or unstaged-only review scoping

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Command coverage | 7/7 commands functional | Manual smoke test of each command |
| Test suite | All tests pass | `node --test tests/*.test.mjs` |
| Review output quality | Structured JSON with findings | Review produces valid schema-compliant output |
| Background job lifecycle | Complete create/monitor/cancel flow | Run background rescue, check status, retrieve result |
| Auth detection | Correct for OAuth users | Setup correctly reads `~/.gemini/settings.json` |
| Stop gate | Blocks on issues, allows clean exits | Enable gate, verify BLOCK/ALLOW behavior |
