/**
 * Core Gemini CLI integration module.
 *
 * Replaces codex.mjs — spawns the `gemini` CLI binary as a subprocess
 * with --output-format stream-json and parses NDJSON events from stdout.
 *
 * @typedef {((update: string | { message: string, phase: string | null }) => void)} ProgressReporter
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";

const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current state. Pick the next highest-value step and follow through until the task is resolved.";

// ---------------------------------------------------------------------------
// Availability & Auth
// ---------------------------------------------------------------------------

/**
 * Check if the `gemini` binary is available on PATH.
 *
 * @param {string} cwd
 * @param {{ env?: Record<string, string> }} [options]
 * @returns {{ available: boolean, detail: string }}
 */
export function getGeminiAvailability(cwd, options = {}) {
  const env = options.env ?? process.env;
  const result = binaryAvailable("gemini", ["--version"], { cwd, env });
  return result;
}

/**
 * Check if the user is authenticated with Gemini CLI by reading settings.json.
 *
 * @param {{ configDir?: string }} [options]
 * @returns {{ loggedIn: boolean, detail: string }}
 */
export function getGeminiAuthStatus(options = {}) {
  const configDir = options.configDir ?? process.env.GEMINI_CONFIG_HOME ?? path.join(os.homedir(), ".gemini");
  const settingsPath = path.join(configDir, "settings.json");

  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    // selectedType can be at the top level or nested under security.auth
    const selectedType = settings.selectedType ?? settings.security?.auth?.selectedType ?? null;
    if (selectedType) {
      return {
        loggedIn: true,
        detail: `Authenticated via ${selectedType}`
      };
    }
    return {
      loggedIn: false,
      detail: "settings.json found but no selectedType configured"
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        loggedIn: false,
        detail: "~/.gemini/settings.json not found. Run: gemini auth login"
      };
    }
    return {
      loggedIn: false,
      detail: `Error reading settings: ${error.message}`
    };
  }
}

// ---------------------------------------------------------------------------
// NDJSON Stream Parser
// ---------------------------------------------------------------------------

/**
 * Parse a newline-delimited JSON stream, calling onEvent for each parsed object.
 * Malformed lines are skipped with a warning.
 *
 * @param {import("stream").Readable} readable
 * @param {(event: object) => void} onEvent
 * @returns {Promise<void>}
 */
export function parseNdjsonStream(readable, onEvent) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: readable, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        onEvent(parsed);
      } catch {
        // Skip malformed lines
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

function emitProgress(onProgress, message, phase = null) {
  if (!onProgress || !message) return;
  if (!phase) {
    onProgress(message);
  } else {
    onProgress({ message, phase });
  }
}

function describeToolUse(event) {
  const name = event.tool_name || event.name || event.toolName || "unknown";
  return { message: `Running tool: ${name}`, phase: "investigating" };
}

// ---------------------------------------------------------------------------
// Core subprocess runner
// ---------------------------------------------------------------------------

/**
 * Spawn the `gemini` CLI as a subprocess with stream-json output.
 *
 * @param {string} cwd
 * @param {object} options
 * @param {string} options.prompt - The prompt to send
 * @param {string} [options.model] - Model name (e.g., gemini-3-pro-preview)
 * @param {boolean} [options.sandbox] - Enable --sandbox
 * @param {string} [options.approvalMode] - auto_edit | yolo
 * @param {string} [options.resumeSessionId] - Resume a previous session by ID
 * @param {number} [options.timeoutMs] - Kill subprocess after this many ms (default: none)
 * @param {ProgressReporter} [options.onProgress]
 * @param {Record<string, string>} [options.env]
 * @returns {Promise<{ status: number, finalMessage: string, stderr: string, reasoningSummary: string[], touchedFiles: string[], sessionId: string | null, error: Error | null }>}
 */
export function runGeminiProcess(cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ["--output-format", "stream-json"];

    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }
    if (options.sandbox) {
      args.push("--sandbox");
    }
    if (options.approvalMode) {
      args.push("--approval-mode", options.approvalMode);
    }
    if (options.model) {
      args.push("-m", options.model);
    }

    const child = spawn("gemini", args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    // Pass prompt via stdin to avoid E2BIG on large prompts
    if (options.prompt) {
      child.stdin.write(options.prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    let finalMessage = "";
    let stderr = "";
    let sessionId = null;
    const reasoningSummary = [];
    const touchedFiles = [];

    // Capture stderr
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Parse NDJSON from stdout
    // Real Gemini CLI emits: init (session_id), message (delta chunks), tool_use, result
    // Messages with delta:true are streamed chunks that need concatenation.
    // Messages with role:"user" are echoes of the input prompt — skip them.

    parseNdjsonStream(child.stdout, (event) => {
      switch (event.type) {
        case "init":
          // Real Gemini CLI emits session_id in the init event
          if (event.session_id) {
            sessionId = event.session_id;
          }
          break;

        case "message":
        case "partialMessage":
          // Skip user message echoes
          if (event.role === "user") break;

          if (event.content) {
            if (event.delta) {
              // Delta mode: append directly to avoid O(N^2) join
              finalMessage += event.content;
            } else {
              // Non-delta: complete message (fake fixture uses this)
              finalMessage = event.content;
            }
            emitProgress(options.onProgress, `Message received.`, "processing");
          }
          break;

        case "tool_use":
        case "toolCall": {
          const update = describeToolUse(event);
          emitProgress(options.onProgress, update.message, update.phase);
          // Track file paths from tool_use events
          // Real CLI uses "parameters", fake fixture uses "input"
          const toolParams = event.parameters || event.input || {};
          if (toolParams.path || toolParams.file_path || toolParams.dir_path) {
            touchedFiles.push(toolParams.path || toolParams.file_path || toolParams.dir_path);
          }
          // Reset message — a new assistant turn may follow tool use
          finalMessage = "";
          break;
        }

        case "tool_result":
          // Tool execution result — skip (we only track tool invocations)
          break;

        case "reasoning":
          if (event.summary) {
            const text = typeof event.summary === "string" ? event.summary : JSON.stringify(event.summary);
            reasoningSummary.push(text);
          }
          break;

        case "result":
          // Real Gemini CLI does not include session_id in result,
          // but handle it for compatibility with test fixtures
          if (event.session_id) {
            sessionId = event.session_id;
          }
          emitProgress(options.onProgress, "Gemini completed.", "finalizing");
          break;

        case "session":
        case "session_start":
          // Compatibility with test fixture
          if (event.session_id) {
            sessionId = event.session_id;
          }
          break;

        case "error":
          emitProgress(options.onProgress, `Gemini error: ${event.message || event.error}`, "failed");
          break;

        default:
          // Unknown event type — skip
          break;
      }
    }).catch(() => {
      // Stream parsing errors are non-fatal
    });

    // Subprocess timeout (NFR-001)
    let timedOut = false;
    let timeoutTimer = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        emitProgress(options.onProgress, `Gemini subprocess timed out after ${Math.round(options.timeoutMs / 1000)}s.`, "failed");
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, options.timeoutMs);
      timeoutTimer.unref?.();
    }

    child.on("error", (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve({
        status: 1,
        finalMessage,
        stderr: stderr.trim(),
        reasoningSummary,
        touchedFiles,
        sessionId,
        error: err
      });
    });

    child.on("close", (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve({
        status: code ?? 1,
        finalMessage,
        stderr: stderr.trim(),
        reasoningSummary,
        touchedFiles,
        sessionId,
        error: timedOut
          ? new Error(`gemini subprocess timed out after ${Math.round(options.timeoutMs / 1000)}s`)
          : code !== 0 ? new Error(`gemini exited with code ${code}`) : null
      });
    });
  });
}

// ---------------------------------------------------------------------------
// High-level review & turn functions
// ---------------------------------------------------------------------------

/**
 * Run a Gemini review (read-only, yolo approval, sandbox).
 *
 * @param {string} cwd
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {ProgressReporter} [options.onProgress]
 * @param {Record<string, string>} [options.env]
 * @returns {Promise<{ status: number, finalMessage: string, stderr: string, reasoningSummary: string[], touchedFiles: string[], error: Error | null }>}
 */
const REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

export async function runGeminiReview(cwd, options = {}) {
  emitProgress(options.onProgress, "Starting Gemini review.", "starting");

  return runGeminiProcess(cwd, {
    prompt: options.prompt,
    model: options.model,
    sandbox: true,
    approvalMode: "yolo",
    timeoutMs: options.timeoutMs ?? REVIEW_TIMEOUT_MS,
    onProgress: options.onProgress,
    env: options.env
  });
}

/**
 * Run a Gemini task/turn (potentially writable).
 *
 * @param {string} cwd
 * @param {object} options
 * @param {string} options.prompt
 * @param {boolean} [options.writable=true] - Whether the task can write files
 * @param {string} [options.model]
 * @param {string} [options.resumeSessionId] - Resume a previous Gemini session
 * @param {ProgressReporter} [options.onProgress]
 * @param {Record<string, string>} [options.env]
 * @returns {Promise<{ status: number, finalMessage: string, stderr: string, reasoningSummary: string[], touchedFiles: string[], sessionId: string | null, error: Error | null }>}
 */
export async function runGeminiTurn(cwd, options = {}) {
  const writable = options.writable ?? true;

  if (options.resumeSessionId) {
    emitProgress(options.onProgress, `Resuming Gemini session ${options.resumeSessionId}.`, "starting");
  } else {
    emitProgress(options.onProgress, "Starting Gemini task.", "starting");
  }

  return runGeminiProcess(cwd, {
    prompt: options.prompt,
    model: options.model,
    sandbox: !writable,
    approvalMode: writable ? "auto_edit" : "yolo",
    resumeSessionId: options.resumeSessionId,
    timeoutMs: options.timeoutMs ?? TASK_TIMEOUT_MS,
    onProgress: options.onProgress,
    env: options.env
  });
}

// ---------------------------------------------------------------------------
// Structured output parsing (reused from codex.mjs — tool-agnostic)
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences from a string.
 * Gemini often wraps JSON output in ```json ... ``` blocks.
 */
function stripMarkdownFences(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return match ? match[1].trim() : trimmed;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Gemini did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  // Try raw first, then try stripping markdown fences
  const candidates = [rawOutput, stripMarkdownFences(rawOutput)];
  for (const candidate of candidates) {
    try {
      return {
        parsed: JSON.parse(candidate),
        parseError: null,
        rawOutput,
        ...fallback
      };
    } catch {
      // Try next candidate
    }
  }

  return {
    parsed: null,
    parseError: `Could not parse JSON from Gemini output (tried raw and fence-stripped).`,
    rawOutput,
    ...fallback
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT };
