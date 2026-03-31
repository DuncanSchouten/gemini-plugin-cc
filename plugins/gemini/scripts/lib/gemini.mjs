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
    if (settings.selectedType) {
      return {
        loggedIn: true,
        detail: `Authenticated via ${settings.selectedType}`
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
  const name = event.name || event.toolName || "unknown";
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
 * @param {ProgressReporter} [options.onProgress]
 * @param {Record<string, string>} [options.env]
 * @returns {Promise<{ status: number, finalMessage: string, stderr: string, reasoningSummary: string[], touchedFiles: string[], error: Error | null }>}
 */
export function runGeminiProcess(cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", options.prompt, "--output-format", "stream-json"];

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

    let finalMessage = "";
    let stderr = "";
    const reasoningSummary = [];
    const touchedFiles = [];

    // Capture stderr
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Parse NDJSON from stdout
    parseNdjsonStream(child.stdout, (event) => {
      switch (event.type) {
        case "message":
        case "partialMessage":
          if (event.content) {
            finalMessage = event.content;
            emitProgress(options.onProgress, `Message received.`, "processing");
          }
          break;

        case "tool_use":
        case "toolCall": {
          const update = describeToolUse(event);
          emitProgress(options.onProgress, update.message, update.phase);
          // Track file paths from tool_use events
          if (event.input?.path) {
            touchedFiles.push(event.input.path);
          }
          break;
        }

        case "reasoning":
          if (event.summary) {
            const text = typeof event.summary === "string" ? event.summary : JSON.stringify(event.summary);
            reasoningSummary.push(text);
          }
          break;

        case "result":
          emitProgress(options.onProgress, "Gemini completed.", "finalizing");
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

    child.on("error", (err) => {
      resolve({
        status: 1,
        finalMessage,
        stderr: stderr.trim(),
        reasoningSummary,
        touchedFiles,
        error: err
      });
    });

    child.on("close", (code) => {
      resolve({
        status: code ?? 1,
        finalMessage,
        stderr: stderr.trim(),
        reasoningSummary,
        touchedFiles,
        error: code !== 0 ? new Error(`gemini exited with code ${code}`) : null
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
export async function runGeminiReview(cwd, options = {}) {
  emitProgress(options.onProgress, "Starting Gemini review.", "starting");

  return runGeminiProcess(cwd, {
    prompt: options.prompt,
    model: options.model,
    sandbox: true,
    approvalMode: "yolo",
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
 * @param {string} [options.sandbox]
 * @param {ProgressReporter} [options.onProgress]
 * @param {Record<string, string>} [options.env]
 * @returns {Promise<{ status: number, finalMessage: string, stderr: string, reasoningSummary: string[], touchedFiles: string[], error: Error | null }>}
 */
export async function runGeminiTurn(cwd, options = {}) {
  const writable = options.writable ?? true;

  emitProgress(options.onProgress, "Starting Gemini task.", "starting");

  return runGeminiProcess(cwd, {
    prompt: options.prompt,
    model: options.model,
    sandbox: !writable,
    approvalMode: writable ? "auto_edit" : "yolo",
    onProgress: options.onProgress,
    env: options.env
  });
}

// ---------------------------------------------------------------------------
// Structured output parsing (reused from codex.mjs — tool-agnostic)
// ---------------------------------------------------------------------------

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Gemini did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT };
