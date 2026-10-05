import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "dispatch-relay-handback.mjs");
const COMPANION = `node "${PLUGIN_ROOT}/scripts/codex-companion.mjs"`;
const DISPATCH = `${COMPANION} dispatch <<'CODEX_DISPATCH_PROMPT_EOF'\nAudit the parser.\nCODEX_DISPATCH_PROMPT_EOF`;
const REPORT = "## Outcome\nDone.\n\n---\nCodex dispatch evidence (observed by the plugin runtime, not written by Codex):\nStatus: completed · job dispatch-1";

let agentCounter = 0;
function newAgent() {
  agentCounter += 1;
  return `relay-${process.pid}-${agentCounter}`;
}

function hook(input) {
  const result = run("node", [HOOK], { input: JSON.stringify(input) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function bashDone(agentId, command, toolResponse) {
  return hook({
    hook_event_name: "PostToolUse",
    agent_id: agentId,
    agent_type: "codex:dispatch",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: toolResponse
  });
}

function handback(agentId, message = "The relay's own paraphrase.", agentType = "codex:dispatch") {
  return hook({
    hook_event_name: "PreToolUse",
    agent_id: agentId,
    agent_type: agentType,
    tool_name: "SubagentHandback",
    tool_input: { message }
  });
}

test("the relay's handback is replaced by the recorded dispatch output, verbatim", () => {
  const agent = newAgent();
  assert.equal(bashDone(agent, DISPATCH, { stdout: `${REPORT}\n`, stderr: "", interrupted: false }), null);

  const decision = handback(agent).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "allow");
  assert.equal(decision.updatedInput.message, REPORT);
});

test("the latest command wins, stderr is kept, and a string tool response works", () => {
  const agent = newAgent();
  const wait = `${COMPANION} wait dispatch-1 --cwd "/repo"`;
  bashDone(agent, DISPATCH, { stdout: "Codex dispatch dispatch-1 is still running.\nNEXT: " + wait, stderr: "" });
  bashDone(agent, wait, { stdout: REPORT, stderr: "warning: something on stderr" });
  assert.equal(handback(agent).hookSpecificOutput.updatedInput.message, `${REPORT}\nwarning: something on stderr`);

  const other = newAgent();
  bashDone(other, DISPATCH, REPORT);
  assert.equal(handback(other).hookSpecificOutput.updatedInput.message, REPORT);
});

test("a record is used once, so a later handback without a command is not given a stale report", () => {
  const agent = newAgent();
  bashDone(agent, DISPATCH, { stdout: REPORT });
  assert.ok(handback(agent));
  assert.equal(handback(agent, "This payload contains the line CODEX_DISPATCH_PROMPT_EOF."), null);
});

test("only the relay's own dispatch commands are recorded and only its handbacks are replaced", () => {
  const agent = newAgent();
  // A command the guard would deny is never recorded.
  bashDone(agent, "cat secrets.txt", { stdout: "secret" });
  assert.equal(handback(agent), null);

  const other = newAgent();
  bashDone(other, DISPATCH, { stdout: REPORT });
  assert.equal(handback(other, "message", "general-purpose"), null);
  assert.equal(
    hook({ hook_event_name: "PostToolUse", agent_id: other, agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: DISPATCH }, tool_response: { stdout: "x" } }),
    null
  );
});

test("a malformed payload never blocks the relay", () => {
  const result = run("node", [HOOK], { input: "not json" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});
