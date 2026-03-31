import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { makeTempDir } from "./helpers.mjs";
import { installFakeGemini, installFakeGeminiConfig, buildEnv } from "./fake-gemini-fixture.mjs";

// These imports will fail until gemini.mjs exists (RED phase)
import {
  getGeminiAvailability,
  getGeminiAuthStatus,
  parseNdjsonStream,
  runGeminiProcess,
  runGeminiReview,
  runGeminiTurn,
  parseStructuredOutput,
  readOutputSchema,
  DEFAULT_CONTINUE_PROMPT
} from "../plugins/gemini/scripts/lib/gemini.mjs";

// ---------------------------------------------------------------------------
// getGeminiAvailability
// ---------------------------------------------------------------------------

test("getGeminiAvailability returns available when fake gemini is on PATH", () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "review-ok");
  const result = getGeminiAvailability(tmp, { env: buildEnv(tmp) });
  assert.equal(result.available, true);
  assert.match(result.detail, /gemini/i);
});

test("getGeminiAvailability returns unavailable when gemini is not on PATH", () => {
  const result = getGeminiAvailability("/nonexistent", { env: { PATH: "/nonexistent" } });
  assert.equal(result.available, false);
});

// ---------------------------------------------------------------------------
// getGeminiAuthStatus
// ---------------------------------------------------------------------------

test("getGeminiAuthStatus returns loggedIn when settings.json has selectedType", () => {
  const tmp = makeTempDir();
  const configDir = path.join(tmp, ".gemini");
  installFakeGeminiConfig(configDir, { selectedType: "oauth-personal" });
  const result = getGeminiAuthStatus({ configDir });
  assert.equal(result.loggedIn, true);
  assert.match(result.detail, /oauth-personal/i);
});

test("getGeminiAuthStatus returns not loggedIn when settings.json is missing", () => {
  const tmp = makeTempDir();
  const configDir = path.join(tmp, ".gemini-nonexistent");
  const result = getGeminiAuthStatus({ configDir });
  assert.equal(result.loggedIn, false);
});

test("getGeminiAuthStatus returns not loggedIn when selectedType is absent", () => {
  const tmp = makeTempDir();
  const configDir = path.join(tmp, ".gemini");
  installFakeGeminiConfig(configDir, {}); // no selectedType
  const result = getGeminiAuthStatus({ configDir });
  assert.equal(result.loggedIn, false);
});

// ---------------------------------------------------------------------------
// parseNdjsonStream
// ---------------------------------------------------------------------------

test("parseNdjsonStream correctly parses multiline NDJSON", async () => {
  const lines = [
    JSON.stringify({ type: "tool_use", name: "read_file" }),
    JSON.stringify({ type: "message", content: "Hello world" }),
    JSON.stringify({ type: "result", status: "completed" })
  ].join("\n") + "\n";

  const stream = Readable.from([lines]);
  const events = [];
  await parseNdjsonStream(stream, (event) => events.push(event));

  assert.equal(events.length, 3);
  assert.equal(events[0].type, "tool_use");
  assert.equal(events[0].name, "read_file");
  assert.equal(events[1].type, "message");
  assert.equal(events[1].content, "Hello world");
  assert.equal(events[2].type, "result");
});

test("parseNdjsonStream skips malformed lines without crashing", async () => {
  const lines = [
    JSON.stringify({ type: "message", content: "good" }),
    "this is not json",
    JSON.stringify({ type: "result", status: "completed" })
  ].join("\n") + "\n";

  const stream = Readable.from([lines]);
  const events = [];
  await parseNdjsonStream(stream, (event) => events.push(event));

  assert.equal(events.length, 2);
  assert.equal(events[0].content, "good");
  assert.equal(events[1].type, "result");
});

test("parseNdjsonStream handles empty lines", async () => {
  const lines = [
    "",
    JSON.stringify({ type: "message", content: "hello" }),
    "",
    ""
  ].join("\n") + "\n";

  const stream = Readable.from([lines]);
  const events = [];
  await parseNdjsonStream(stream, (event) => events.push(event));

  assert.equal(events.length, 1);
  assert.equal(events[0].content, "hello");
});

// ---------------------------------------------------------------------------
// runGeminiProcess
// ---------------------------------------------------------------------------

test("runGeminiProcess spawns gemini and captures events", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const result = await runGeminiProcess(tmp, {
    prompt: "fix the bug",
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  assert.ok(result.finalMessage.includes("Handled the requested task"));
});

test("runGeminiProcess captures tool_use events", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const toolNames = [];
  const result = await runGeminiProcess(tmp, {
    prompt: "fix the bug",
    env: buildEnv(tmp),
    onProgress: (update) => {
      if (typeof update === "object" && update.phase === "investigating") {
        toolNames.push(update.message);
      }
    }
  });

  assert.equal(result.status, 0);
  assert.ok(toolNames.length > 0, "Should have captured at least one tool_use progress event");
});

test("runGeminiProcess returns error on non-zero exit", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "auth-error");

  const result = await runGeminiProcess(tmp, {
    prompt: "fix the bug",
    env: buildEnv(tmp)
  });

  assert.ok(result.status !== 0);
  assert.ok(result.stderr.includes("Not authenticated") || result.error);
});

// ---------------------------------------------------------------------------
// runGeminiReview
// ---------------------------------------------------------------------------

test("runGeminiReview uses yolo approval mode and sandbox", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "review-ok");

  const result = await runGeminiReview(tmp, {
    prompt: "You are performing an adversarial software review of the provided repository",
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  assert.ok(result.finalMessage, "Should have a final message");
});

test("runGeminiReview returns structured review output", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "adversarial-findings");

  const result = await runGeminiReview(tmp, {
    prompt: "You are performing an adversarial software review",
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  // The final message should contain the structured JSON
  const parsed = JSON.parse(result.finalMessage);
  assert.equal(parsed.verdict, "needs-attention");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].title, "Missing empty-state guard");
});

// ---------------------------------------------------------------------------
// runGeminiTurn
// ---------------------------------------------------------------------------

test("runGeminiTurn uses auto_edit approval mode for write tasks", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const result = await runGeminiTurn(tmp, {
    prompt: "Fix the authentication bug",
    writable: true,
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  assert.ok(result.finalMessage.includes("Handled the requested task"));
});

test("runGeminiTurn uses yolo for read-only tasks", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const result = await runGeminiTurn(tmp, {
    prompt: "Explain the codebase",
    writable: false,
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  assert.ok(result.finalMessage.includes("Handled the requested task"));
});

test("runGeminiTurn passes model flag when specified", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const result = await runGeminiTurn(tmp, {
    prompt: "Fix the bug",
    model: "gemini-3-pro-preview",
    writable: true,
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
});

// ---------------------------------------------------------------------------
// Session resume support
// ---------------------------------------------------------------------------

test("runGeminiProcess captures session_id from result event", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const result = await runGeminiProcess(tmp, {
    prompt: "fix the bug",
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  assert.ok(result.sessionId, "Should capture a session ID from the stream");
  assert.match(result.sessionId, /^fake-session-/);
});

test("runGeminiProcess passes --resume flag when resumeSessionId is provided", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const result = await runGeminiProcess(tmp, {
    prompt: "follow up on the fix",
    resumeSessionId: "fake-session-previous",
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  assert.ok(result.finalMessage.includes("Resumed the prior session"));
  assert.equal(result.sessionId, "fake-session-previous");
});

test("runGeminiTurn passes resumeSessionId through to runGeminiProcess", async () => {
  const tmp = makeTempDir();
  installFakeGemini(tmp, "task-ok");

  const result = await runGeminiTurn(tmp, {
    prompt: "continue the investigation",
    resumeSessionId: "fake-session-abc123",
    writable: true,
    env: buildEnv(tmp)
  });

  assert.equal(result.status, 0);
  assert.ok(result.finalMessage.includes("Resumed the prior session"));
  assert.equal(result.sessionId, "fake-session-abc123");
});

// ---------------------------------------------------------------------------
// parseStructuredOutput (reused from codex.mjs, tool-agnostic)
// ---------------------------------------------------------------------------

test("parseStructuredOutput parses valid JSON", () => {
  const raw = JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] });
  const result = parseStructuredOutput(raw);
  assert.equal(result.parsed.verdict, "approve");
  assert.equal(result.parseError, null);
});

test("parseStructuredOutput returns parseError for invalid JSON", () => {
  const result = parseStructuredOutput("not valid json");
  assert.equal(result.parsed, null);
  assert.ok(result.parseError);
});

test("parseStructuredOutput handles null input", () => {
  const result = parseStructuredOutput(null);
  assert.equal(result.parsed, null);
  assert.ok(result.parseError);
});

// ---------------------------------------------------------------------------
// DEFAULT_CONTINUE_PROMPT
// ---------------------------------------------------------------------------

test("DEFAULT_CONTINUE_PROMPT is a non-empty string", () => {
  assert.ok(typeof DEFAULT_CONTINUE_PROMPT === "string");
  assert.ok(DEFAULT_CONTINUE_PROMPT.length > 0);
});
