import fs from "node:fs";
import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

/**
 * Installs a fake `gemini` CLI binary that outputs NDJSON events to stdout
 * based on the configured behavior. Much simpler than the Codex fixture
 * because there is no app server protocol — just subprocess stdin/stdout.
 *
 * @param {string} binDir - Directory to install the fake binary into
 * @param {string} behavior - One of: review-ok, adversarial-findings, adversarial-clean,
 *   task-ok, slow-task, invalid-json, auth-error, with-reasoning
 */
export function installFakeGemini(binDir, behavior = "review-ok") {
  const scriptPath = path.join(binDir, "gemini");
  const source = `#!/usr/bin/env node
const BEHAVIOR = ${JSON.stringify(behavior)};

const args = process.argv.slice(2);

// Handle --version
if (args.includes("--version")) {
  console.log("gemini-cli 0.21.1 (fake)");
  process.exit(0);
}

// Handle auth login
if (args[0] === "auth" && args[1] === "login") {
  if (BEHAVIOR === "auth-error") {
    console.error("Authentication failed. Run: gemini auth login");
    process.exit(1);
  }
  console.log("Already authenticated.");
  process.exit(0);
}

// Find the prompt flag
let prompt = "";
const promptIndex = args.indexOf("-p");
if (promptIndex >= 0 && args[promptIndex + 1]) {
  prompt = args[promptIndex + 1];
}

// Determine output format
const outputFormatIndex = args.indexOf("--output-format");
const outputFormat = outputFormatIndex >= 0 ? args[outputFormatIndex + 1] : "text";

// Determine resume session
const resumeIndex = args.indexOf("--resume");
const resumeSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;

// Determine model
const modelIndex = args.indexOf("-m");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "auto";

// Determine approval mode
const approvalIndex = args.indexOf("--approval-mode");
const approvalMode = approvalIndex >= 0 ? args[approvalIndex + 1] : "default";

// Determine sandbox
const sandbox = args.includes("--sandbox");

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function sendText(text) {
  if (outputFormat === "stream-json") {
    send({ type: "message", content: text });
  } else if (outputFormat === "json") {
    send({ response: text });
  } else {
    process.stdout.write(text + "\\n");
  }
}

// Simulate slow task by waiting
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function structuredReviewPayload() {
  if (BEHAVIOR === "adversarial-findings") {
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function isReviewPrompt() {
  return prompt.includes("adversarial software review") ||
    prompt.includes("code review") ||
    prompt.includes("review the provided repository");
}

function isStopGatePrompt() {
  return prompt.includes("stop-gate review") ||
    prompt.includes("Only review the work from the previous Claude turn");
}

async function main() {
  if (BEHAVIOR === "auth-error" && prompt) {
    console.error("Error: Not authenticated. Run: gemini auth login");
    process.exit(1);
  }

  if (!prompt) {
    console.error("Error: No prompt provided. Use -p to specify a prompt.");
    process.exit(1);
  }

  if (outputFormat === "stream-json") {
    // Emit tool_use event for progress tracking
    send({ type: "tool_use", name: "read_file", input: { path: "src/app.js" } });

    if (BEHAVIOR === "with-reasoning") {
      send({
        type: "reasoning",
        summary: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first."
      });
    }

    if (BEHAVIOR === "slow-task") {
      send({ type: "message", content: "Working on the task..." });
      await delay(400);
    }

    if (isStopGatePrompt()) {
      if (BEHAVIOR === "adversarial-clean") {
        send({ type: "message", content: "ALLOW: No blocking issues found in the previous turn." });
        send({ type: "result", status: "completed" });
      } else {
        send({ type: "message", content: "BLOCK: Missing empty-state guard in src/app.js:4-6." });
        send({ type: "result", status: "completed" });
      }
    } else if (isReviewPrompt()) {
      const payload = structuredReviewPayload();
      send({ type: "message", content: payload });
      send({ type: "result", status: "completed", session_id: "fake-session-review-001" });
    } else {
      // Task mode
      const fakeSessionId = resumeSessionId || "fake-session-" + Date.now();
      send({ type: "session_start", session_id: fakeSessionId });
      send({ type: "tool_use", name: "edit_file", input: { path: "src/fix.js", content: "fixed" } });
      if (resumeSessionId) {
        send({ type: "message", content: "Resumed the prior session.\\nFollow-up prompt accepted." });
      } else {
        send({ type: "message", content: "Handled the requested task.\\nTask prompt accepted." });
      }
      send({ type: "result", status: "completed", session_id: fakeSessionId });
    }
  } else if (outputFormat === "json") {
    if (isReviewPrompt()) {
      const payload = structuredReviewPayload();
      console.log(JSON.stringify({ response: payload }));
    } else {
      console.log(JSON.stringify({ response: "Handled the requested task.\\nTask prompt accepted." }));
    }
  } else {
    // Plain text
    if (isReviewPrompt()) {
      console.log(structuredReviewPayload());
    } else {
      console.log("Handled the requested task.\\nTask prompt accepted.");
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
`;
  writeExecutable(scriptPath, source);
}

/**
 * Creates a fake ~/.gemini/settings.json for testing auth detection.
 *
 * @param {string} configDir - Directory to create settings.json in
 * @param {object} options - { selectedType?: string }
 */
export function installFakeGeminiConfig(configDir, options = {}) {
  fs.mkdirSync(configDir, { recursive: true });
  const settings = {};
  if (options.selectedType) {
    settings.selectedType = options.selectedType;
  }
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify(settings, null, 2)
  );
}

export function buildEnv(binDir, options = {}) {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    ...(options.configDir ? { GEMINI_CONFIG_HOME: options.configDir } : {})
  };
}
