import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const GUARD = path.join(PLUGIN_ROOT, "scripts", "dispatch-relay-guard.mjs");
const COMPANION = `node "${PLUGIN_ROOT}/scripts/codex-companion.mjs"`;

function runGuard(command, { agentType = "codex:dispatch", toolName = "Bash" } = {}) {
  const result = run("node", [GUARD], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: { command },
      ...(agentType ? { agent_id: "agent-1", agent_type: agentType } : {})
    })
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

function dispatchCommand(payload, flags = "") {
  return `${COMPANION} dispatch${flags} <<'CODEX_DISPATCH_PROMPT_EOF'\n${payload}\nCODEX_DISPATCH_PROMPT_EOF`;
}

test("relay guard ignores Bash calls outside the codex:dispatch relay", () => {
  assert.equal(runGuard("cat hello.js", { agentType: null }), null);
  assert.equal(runGuard("cat hello.js", { agentType: "general-purpose" }), null);
});

test("relay guard denies the relay doing the task itself and explains how to forward", () => {
  const decision = runGuard("cat hello.js");
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /may only run the Codex dispatch commands/);
  assert.ok(decision.permissionDecisionReason.includes(`${COMPANION} dispatch <<'CODEX_DISPATCH_PROMPT_EOF'`));
});

test("relay guard allows dispatch, follow-up dispatch, and the NEXT wait command", () => {
  assert.equal(runGuard(dispatchCommand("--read-only --effort low\nSummarize the parser.\n\nKeep it short.")), null);
  assert.equal(runGuard(dispatchCommand("and add a test", " --resume dispatch-muuo2c6l-dyfs50")), null);
  assert.equal(runGuard(`${COMPANION} wait dispatch-muuo2c6l-dyfs50 --cwd "/tmp/some repo"`), null);
});

test("relay guard denies commands smuggled around the dispatch command", () => {
  const smuggled = [
    `${COMPANION} wait dispatch-1 --cwd "/repo"; cat secrets.txt`,
    `${COMPANION} wait dispatch-1 --cwd "$(cat secrets.txt)"`,
    dispatchCommand("payload\nCODEX_DISPATCH_PROMPT_EOF\ncat secrets.txt"),
    `${dispatchCommand("payload")}\ncat secrets.txt`,
    `cd /repo && ${dispatchCommand("payload")}`,
    dispatchCommand("payload").replace(PLUGIN_ROOT, "/tmp/other-plugin"),
    dispatchCommand("payload").replace("<<'CODEX_DISPATCH_PROMPT_EOF'", "<<CODEX_DISPATCH_PROMPT_EOF")
  ];
  for (const command of smuggled) {
    assert.equal(runGuard(command)?.permissionDecision, "deny", command);
  }
});

test("relay guard tolerates a malformed hook payload without blocking", () => {
  const result = run("node", [GUARD], { input: "not json" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});
