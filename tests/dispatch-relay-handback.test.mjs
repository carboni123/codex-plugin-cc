import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { parseDispatchHandoff, renderDispatchHandoff } from "../plugins/codex/scripts/lib/dispatch-handoff.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "dispatch-relay-handback.mjs");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const COMPANION = `node "${SCRIPT}"`;
const DISPATCH = `${COMPANION} dispatch --relay <<'CODEX_DISPATCH_PROMPT_EOF'\nAudit the parser.\nCODEX_DISPATCH_PROMPT_EOF`;
const RECORDS = path.join(process.env.CLAUDE_PLUGIN_DATA, "relay-handback");

let agentCounter = 0;
function newAgent() {
  agentCounter += 1;
  return `relay-${process.pid}-${agentCounter}`;
}

function setupRepo(behavior = "with-tool-activity") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, env: buildEnv(binDir) };
}

// Runs a dispatch the way the relay does and returns what the relay saw plus the stored report.
function relayDispatch(ctx, task = "Audit the parser.") {
  const relayed = run("node", [SCRIPT, "dispatch", "--relay"], { cwd: ctx.repo, env: ctx.env, input: task });
  assert.equal(relayed.status, 0, relayed.stderr);
  const { jobId } = parseDispatchHandoff(relayed.stdout);
  const stored = run("node", [SCRIPT, "wait", jobId, "--timeout", "0"], { cwd: ctx.repo, env: ctx.env });
  return { jobId, handoff: relayed.stdout, report: stored.stdout.trimEnd() };
}

function hook(input, ctx) {
  const result = run("node", [HOOK], { input: JSON.stringify({ cwd: ctx?.repo, ...input }), env: ctx?.env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function bashDone(agentId, command, stdout, ctx, agentType = "codex:dispatch") {
  return hook(
    {
      hook_event_name: "PostToolUse",
      agent_id: agentId,
      agent_type: agentType,
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr: "", interrupted: false, isImage: false }
    },
    ctx
  );
}

function notification(agentId, result) {
  return {
    hook_event_name: "UserPromptSubmit",
    prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent "Codex: audit" finished</summary>\n<result>${result}</result>\n</task-notification>`
  };
}

function foregroundResult(agentId, text, overrides = {}) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: "Codex: audit", prompt: "Audit the parser.", subagent_type: "codex:dispatch" },
    tool_response: {
      status: "completed",
      agentId,
      agentType: "codex:dispatch",
      content: [{ type: "text", text }],
      totalDurationMs: 4200,
      totalToolUseCount: 1,
      ...overrides
    }
  };
}

test("the handoff names the job and its outcome, and parses back", () => {
  const completed = renderDispatchHandoff({ id: "dispatch-mg2k1c-x81", status: "completed", duration: "4m 12s" });
  assert.equal(
    completed,
    "Codex dispatch dispatch-mg2k1c-x81 completed after 4m 12s.\n" +
      "The Codex plugin attaches Codex's report and the runtime evidence to this result. If they are missing, run /codex:result dispatch-mg2k1c-x81\n"
  );
  assert.deepEqual(parseDispatchHandoff(completed), { jobId: "dispatch-mg2k1c-x81", status: "completed" });
  assert.deepEqual(parseDispatchHandoff(renderDispatchHandoff({ id: "dispatch-2", status: "failed" })), { jobId: "dispatch-2", status: "failed" });
  assert.deepEqual(parseDispatchHandoff(renderDispatchHandoff({ id: "dispatch-3", status: "cancelled" })), { jobId: "dispatch-3", status: "cancelled" });
  assert.equal(parseDispatchHandoff("Codex dispatch dispatch-4 is still running (1m 40s elapsed).\nNEXT: node x wait dispatch-4"), null);
});

test("in relay mode the companion prints the handoff, never the report", () => {
  const ctx = setupRepo();
  const { jobId, handoff, report } = relayDispatch(ctx);

  assert.match(handoff, new RegExp(`^Codex dispatch ${jobId} completed after \\d+s\\.\\nThe Codex plugin attaches`));
  assert.doesNotMatch(handoff, /Handled the requested task|Codex dispatch evidence/);
  assert.match(report, /^Handled the requested task\./);
  assert.match(report, new RegExp(`Codex dispatch evidence[\\s\\S]*job ${jobId}`));
});

test("a relay-mode checkpoint keeps --relay on the NEXT command, and wait --relay ends with the handoff", () => {
  const ctx = setupRepo("interruptible-slow-task");
  const pending = run("node", [SCRIPT, "dispatch", "--relay", "--timeout", "1s", "Run the slow migration."], { cwd: ctx.repo, env: ctx.env });
  assert.equal(pending.status, 0, pending.stderr);
  const next = pending.stdout.trim().split("\n").at(-1);
  assert.match(next, /^NEXT: node ".+codex-companion\.mjs" wait dispatch-\S+ --cwd ".+" --relay$/);

  const jobId = next.match(/wait (dispatch-\S+)/)[1];
  const finished = run("node", [SCRIPT, "wait", jobId, "--timeout", "20s", "--relay"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(parseDispatchHandoff(finished.stdout), { jobId, status: "completed" });
  assert.doesNotMatch(finished.stdout, /Handled the requested task|NEXT:/);
});

test("a dispatch that did not complete still exits 0 in relay mode, so the hook that notes the job runs", () => {
  const ctx = setupRepo("interruptible-slow-task");
  const launched = JSON.parse(run("node", [SCRIPT, "dispatch", "--timeout", "0", "--json", "Run the slow migration."], { cwd: ctx.repo, env: ctx.env }).stdout);
  assert.equal(run("node", [SCRIPT, "cancel", launched.jobId], { cwd: ctx.repo, env: ctx.env }).status, 0);

  const relayed = run("node", [SCRIPT, "wait", launched.jobId, "--relay"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(relayed.status, 0, relayed.stderr);
  assert.deepEqual(parseDispatchHandoff(relayed.stdout), { jobId: launched.jobId, status: "cancelled" });
  assert.equal(run("node", [SCRIPT, "wait", launched.jobId], { cwd: ctx.repo, env: ctx.env }).status, 1);
});

test("a background relay's completion notification gets the stored report as context", () => {
  const ctx = setupRepo();
  const { jobId, handoff, report } = relayDispatch(ctx);
  const agent = newAgent();
  assert.equal(bashDone(agent, DISPATCH, handoff, ctx), null);

  const output = hook(notification(agent, "Codex finished; here is my own summary of what it did."), ctx).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.ok(output.additionalContext.startsWith(`Codex dispatch report for job ${jobId}, exactly as the Codex plugin stored it.`));
  assert.ok(output.additionalContext.endsWith(`\n\n${report}`));
});

test("a foreground relay's result is replaced by the stored report, keeping the Agent tool's output shape", () => {
  const ctx = setupRepo();
  const { handoff, report } = relayDispatch(ctx);
  const agent = newAgent();
  bashDone(agent, DISPATCH, handoff, ctx);

  const input = foregroundResult(agent, "Codex finished; here is my own summary.");
  const output = hook(input, ctx).hookSpecificOutput;
  assert.equal(output.hookEventName, "PostToolUse");
  assert.deepEqual(output.updatedToolOutput, { ...input.tool_response, content: [{ type: "text", text: report }] });
});

test("a foreground result in a shape that cannot be replaced gets the report as context instead", () => {
  const ctx = setupRepo();
  const { handoff, report } = relayDispatch(ctx);
  const agent = newAgent();
  bashDone(agent, DISPATCH, handoff, ctx);

  const output = hook(foregroundResult(agent, "", { content: "plain text result" }), ctx).hookSpecificOutput;
  assert.equal(output.updatedToolOutput, undefined);
  assert.ok(output.additionalContext.endsWith(`\n\n${report}`));
});

test("in auto mode the relay's SubagentHandback message is replaced by the stored report", () => {
  const ctx = setupRepo();
  const { handoff, report } = relayDispatch(ctx);
  const agent = newAgent();
  bashDone(agent, DISPATCH, handoff, ctx);

  const handback = { hook_event_name: "PreToolUse", agent_id: agent, agent_type: "codex:dispatch", tool_name: "SubagentHandback", tool_input: { message: "The relay's own words." } };
  const decision = hook(handback, ctx).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "allow");
  assert.deepEqual(decision.updatedInput, { message: report });
  // Delivered once: the notification that follows the handback adds nothing.
  assert.equal(hook(notification(agent, report), ctx), null);
});

test("a report is delivered once, and a relay that starts waiting again drops the earlier job's record", () => {
  const ctx = setupRepo();
  const { jobId, handoff } = relayDispatch(ctx);
  const agent = newAgent();
  bashDone(agent, DISPATCH, handoff, ctx);
  assert.ok(hook(notification(agent, handoff), ctx));
  assert.equal(hook(notification(agent, "This payload contains the line CODEX_DISPATCH_PROMPT_EOF."), ctx), null);

  // A follow-up that is still running: the notification of an interrupted relay must not carry the previous report.
  bashDone(agent, DISPATCH, handoff, ctx);
  const wait = `${COMPANION} wait ${jobId} --cwd "${ctx.repo}" --relay`;
  bashDone(agent, wait, `Codex dispatch ${jobId} is still running (1m 40s elapsed).\nNEXT: ${wait}`, ctx);
  assert.equal(hook(notification(agent, "stopped"), ctx), null);
});

test("only the relay's own dispatch commands are noted, and other agents' results are left alone", () => {
  const ctx = setupRepo();
  const { handoff } = relayDispatch(ctx);

  // A command the guard would deny is never noted, whatever it printed.
  const agent = newAgent();
  bashDone(agent, `cat ${path.join(ctx.repo, "notes.txt")}`, handoff, ctx);
  assert.equal(hook(notification(agent, "done"), ctx), null);

  // Another agent type that happens to print a handoff is not a relay.
  const other = newAgent();
  bashDone(other, DISPATCH, handoff, ctx, "general-purpose");
  assert.equal(hook(notification(other, "done"), ctx), null);

  // A relay's record is not used for a foreground result of another agent type.
  const relay = newAgent();
  bashDone(relay, DISPATCH, handoff, ctx);
  assert.equal(hook(foregroundResult(relay, "done", { agentType: "general-purpose" }), ctx), null);
  assert.equal(hook({ ...foregroundResult(relay, "launched"), tool_response: { status: "async_launched", agentId: relay } }, ctx), null);

  // Prompts that are not task notifications cost nothing and add nothing.
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", prompt: `please look at <task-id>${relay}</task-id>` }, ctx), null);
  assert.ok(hook(notification(relay, "done"), ctx));
});

test("a report too long for inline hook context says where the rest is", () => {
  const ctx = setupRepo();
  const { jobId, handoff } = relayDispatch(ctx, `Explain the parser.\n${"Cover every branch of the tokenizer in detail. ".repeat(300)}`);
  const stateRoot = path.join(process.env.CLAUDE_PLUGIN_DATA, "state");
  const jobFile = fs
    .readdirSync(stateRoot)
    .map((dir) => path.join(stateRoot, dir, "jobs", `${jobId}.json`))
    .find((file) => fs.existsSync(file));
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  job.rendered = `${"A long finding about the tokenizer. ".repeat(400)}\n${job.rendered}`;
  fs.writeFileSync(jobFile, JSON.stringify(job));

  const agent = newAgent();
  bashDone(agent, DISPATCH, handoff, ctx);
  const context = hook(notification(agent, handoff), ctx).hookSpecificOutput.additionalContext;
  assert.match(context.slice(0, 600), new RegExp(`The report is \\d+ characters long[\\s\\S]*/codex:result ${jobId} prints it too\\.`));
  assert.ok(context.endsWith(job.rendered.trimEnd()));
});

test("records of results that never reached a caller are removed after three days", () => {
  const ctx = setupRepo();
  const { handoff } = relayDispatch(ctx);
  const stale = path.join(RECORDS, "stale-agent.json");
  fs.mkdirSync(RECORDS, { recursive: true });
  fs.writeFileSync(stale, JSON.stringify({ jobId: "dispatch-old" }));
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, fourDaysAgo, fourDaysAgo);

  const agent = newAgent();
  bashDone(agent, DISPATCH, handoff, ctx);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(path.join(RECORDS, `${agent}.json`)), true);
});

test("a malformed payload never blocks a prompt or a tool call", () => {
  const result = run("node", [HOOK], { input: "not json" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});
