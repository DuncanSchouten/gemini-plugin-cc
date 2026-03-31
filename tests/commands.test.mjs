import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Gemini's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/gemini-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Gemini review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Gemini's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/gemini-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Gemini adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/gemini:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/gemini-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Gemini's output verbatim/i);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|flash\|pro>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Gemini session/);
  assert.match(rescue, /Start a new Gemini session/);
  assert.match(rescue, /run the `gemini:gemini-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` is a runtime-selection flag/i);
  assert.match(rescue, /If they ask for `flash`, map it to `gemini-3-flash-preview`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new session, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Gemini companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Gemini running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `flash`, map that to `--model gemini-3-flash-preview`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gemini-3-pro-preview`, pass it through with `--model`/i);
  assert.match(agent, /Return the stdout of the `gemini-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Gemini cannot be invoked, return nothing/i);
  assert.match(agent, /gemini-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Gemini prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gemini-prompting` skill to rewrite the user's request into a tighter Gemini prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `flash` to `--model gemini-3-flash-preview`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Gemini cannot be invoked, return nothing/i);
  assert.match(readme, /`gemini:gemini-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model`, Gemini CLI uses its default model routing/i);
  assert.match(readme, /--model pro/);
  assert.match(readme, /`flash` maps to `gemini-3-flash-preview`/);
  assert.match(readme, /continue the latest Gemini session/i);
  assert.match(readme, /### `\/gemini:setup`/);
  assert.match(readme, /### `\/gemini:review`/);
  assert.match(readme, /### `\/gemini:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/gemini:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/gemini:rescue`/);
  assert.match(readme, /### `\/gemini:status`/);
  assert.match(readme, /### `\/gemini:result`/);
  assert.match(readme, /### `\/gemini:cancel`/);
});

test("result and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/gemini-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /gemini-companion\.mjs" result \$ARGUMENTS/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /gemini-companion\.mjs" cancel \$ARGUMENTS/);
  assert.match(resultHandling, /do not turn a failed or incomplete Gemini run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Gemini was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gemini-prompting/SKILL.md");
  const promptRecipes = read("skills/gemini-prompting/references/gemini-prompt-recipes.md");

  assert.match(runtimeSkill, /gemini-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Gemini task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Gemini task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Gemini install and still points users to gemini auth login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @google\/gemini-cli/);
  assert.match(setup, /gemini-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!gemini auth login/);
  assert.match(readme, /offer to install/i);
  assert.match(readme, /\/gemini:setup --enable-review-gate/);
  assert.match(readme, /\/gemini:setup --disable-review-gate/);
});
