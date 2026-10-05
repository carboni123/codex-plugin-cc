import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  parseDuration,
  renderDispatchReport,
  splitDispatchDirectives,
  summarizeCommands,
  summarizeFileChanges
} from "../plugins/codex/scripts/lib/dispatch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function setupRepo(behavior) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);
  const readFakeState = () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  return { repo, env, readFakeState };
}

function companion(args, { repo, env }, input) {
  return run("node", [SCRIPT, ...args], { cwd: repo, env, input });
}

test("splitDispatchDirectives parses and strips a leading flag line", () => {
  const { options, prompt } = splitDispatchDirectives("--read-only --effort high --label 'auth audit'\nFind the bug.\n--not a directive");
  assert.deepEqual(options, { "read-only": true, effort: "high", label: "auth audit" });
  assert.equal(prompt, "Find the bug.\n--not a directive");
});

test("splitDispatchDirectives leaves prompts without a flag line untouched", () => {
  const { options, prompt } = splitDispatchDirectives("Fix the bug.\n--read-only is not a directive here");
  assert.deepEqual(options, {});
  assert.equal(prompt, "Fix the bug.\n--read-only is not a directive here");
});

test("splitDispatchDirectives rejects unknown directives instead of sending them to Codex", () => {
  assert.throws(() => splitDispatchDirectives("--readonly\nFix it."), /Unsupported dispatch directive: --readonly/);
});

test("parseDuration accepts seconds by default, units, zero, and none", () => {
  assert.equal(parseDuration(undefined, 5), 5);
  assert.equal(parseDuration("90", 0), 90_000);
  assert.equal(parseDuration("1.5m", 0), 90_000);
  assert.equal(parseDuration("250ms", 0), 250);
  assert.equal(parseDuration("0", 5), 0);
  assert.equal(parseDuration("none", 5), Infinity);
  assert.throws(() => parseDuration("soon", 5), /Invalid duration/);
});

test("summarizeFileChanges keeps created files as added and skips unapplied patches", () => {
  const files = summarizeFileChanges([
    { status: "completed", changes: [{ path: "a.js", kind: { type: "add" } }, { path: "b.js", kind: { type: "update", move_path: null } }] },
    { status: "completed", changes: [{ path: "a.js", kind: { type: "update", move_path: null } }, { path: "c.js", kind: { type: "delete" } }] },
    { status: "failed", changes: [{ path: "d.js", kind: { type: "add" } }] }
  ]);
  assert.deepEqual(files, [
    { path: "a.js", change: "added" },
    { path: "b.js", change: "modified" },
    { path: "c.js", change: "deleted" }
  ]);
});

test("summarizeFileChanges shows paths inside the workspace relative to it", () => {
  const files = summarizeFileChanges(
    [{ status: "completed", changes: [{ path: "/repo/src/a.js", kind: { type: "add" } }, { path: "/elsewhere/b.js", kind: { type: "add" } }] }],
    "/repo"
  );
  assert.deepEqual(files.map((file) => file.path), ["src/a.js", "/elsewhere/b.js"]);
});

test("long runs list the last run of each verification command plus the most recent commands", () => {
  const raw = [
    { command: "npm test", exitCode: 1, status: "failed" },
    ...Array.from({ length: 12 }, (_, index) => ({ command: `rg step${index}`, exitCode: 0, status: "completed" })),
    { command: "npm test", exitCode: 0, status: "completed" },
    { command: "npm run lint", exitCode: 1, status: "failed" },
    ...Array.from({ length: 5 }, (_, index) => ({ command: `cat out${index}`, exitCode: 0, status: "completed" }))
  ];
  const rendered = renderDispatchReport({
    status: "completed",
    jobId: "dispatch-2",
    write: true,
    cwd: "/repo",
    finalMessage: "done",
    files: [],
    commands: summarizeCommands(raw)
  });
  const listed = rendered.split("\n").filter((line) => /^ {2}[✓✗] /.test(line));
  assert.deepEqual(listed, [
    "  ✓ npm test (exit 0)",
    "  ✗ npm run lint (exit 1)",
    ...Array.from({ length: 5 }, (_, index) => `  ✓ cat out${index} (exit 0)`)
  ]);
  assert.match(rendered, /Commands run: 20 \(2 with non-zero exit\)\n {2}\(showing 7:/);
});

test("summarizeCommands unwraps the login shell and flags failures", () => {
  const [first, second] = summarizeCommands([
    { command: "/bin/bash -lc 'npm test -- --grep auth'", exitCode: 1, status: "failed" },
    { command: "rg -n TODO", exitCode: 0, status: "completed" }
  ]);
  assert.equal(first.command, "npm test -- --grep auth");
  assert.equal(first.failed, true);
  assert.equal(first.verification, true);
  assert.equal(second.failed, false);
  assert.equal(second.verification, false);
});

test("renderDispatchReport separates Codex's message from runtime evidence", () => {
  const rendered = renderDispatchReport({
    status: "failed",
    jobId: "dispatch-1",
    threadId: "thr_9",
    write: true,
    cwd: "/repo",
    durationMs: 65_000,
    finalMessage: "",
    error: "turn interrupted",
    files: [],
    commands: summarizeCommands([{ command: "npm test", exitCode: 1, status: "failed" }])
  });
  assert.match(rendered, /^Codex did not return a final message\. Error: turn interrupted/);
  assert.match(rendered, /Status: failed · 1m 5s · job dispatch-1 · thread thr_9/);
  assert.match(rendered, /Error: turn interrupted/);
  assert.match(rendered, /Files changed: none/);
  assert.match(rendered, /✗ npm test \(exit 1\)/);
  assert.match(rendered, /--resume dispatch-1/);
});

test("dispatch runs Codex as a delegated worker and appends runtime evidence", () => {
  const ctx = setupRepo("with-tool-activity");
  const result = companion(["dispatch"], ctx, "--label fix-tests --effort high\nFix the failing test in src/app.js.\n");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\./);
  assert.match(result.stdout, /Codex dispatch evidence \(observed by the plugin runtime, not written by Codex\):/);
  assert.match(result.stdout, /Sandbox: workspace-write/);
  assert.match(result.stdout, /modified: src\/app\.js\n {2}added: src\/new\.js/);
  assert.match(
    result.stdout,
    /Commands run: 3 \(1 with non-zero exit\)\n {2}✗ npm test \(exit 1\)\n {2}✓ npm test \(exit 0\)\n {2}✓ rg -n handler src \(exit 0\)/
  );

  const state = ctx.readFakeState();
  assert.equal(state.lastThreadStart.sandbox, "workspace-write");
  assert.equal(state.lastTurnStart.effort, "high");
  assert.match(state.lastTurnStart.prompt, /<task>\nFix the failing test in src\/app\.js\.\n<\/task>/);
  assert.match(state.lastTurnStart.prompt, /<final_report_contract>/);
  assert.doesNotMatch(state.lastTurnStart.prompt, /--label|--effort/);

  const status = JSON.parse(companion(["status", "--json"], ctx).stdout);
  assert.equal(status.latestFinished.kindLabel, "dispatch");
  assert.equal(status.latestFinished.title, "Codex Dispatch: fix-tests");
  assert.equal(status.latestFinished.summary, "Handled the requested task.");
});

test("dispatch --read-only uses the read-only sandbox and tells Codex not to edit", () => {
  const ctx = setupRepo("task-ok");
  const result = companion(["dispatch"], ctx, "--read-only\nWhere is the session id parsed?");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Sandbox: read-only/);
  assert.match(result.stdout, /Files changed: none \(read-only run\)/);
  const state = ctx.readFakeState();
  assert.equal(state.lastThreadStart.sandbox, "read-only");
  assert.match(state.lastTurnStart.prompt, /This run is read-only/);
});

test("dispatch --resume continues the same Codex thread with a follow-up prompt", () => {
  const ctx = setupRepo("task-ok");
  const first = companion(["dispatch", "--json", "--label", "refactor", "Refactor the parser."], ctx);
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.status, "completed");

  const followUp = companion(["dispatch", "--resume", firstPayload.jobId, "follow up: add a regression test"], ctx);
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.match(followUp.stdout, /^Resumed the prior run\./);

  const state = ctx.readFakeState();
  assert.equal(state.lastThreadResume.threadId, firstPayload.report.threadId);
  assert.match(state.lastTurnStart.prompt, /<follow_up>[\s\S]*follow up: add a regression test/);

  const status = JSON.parse(companion(["status", "--json"], ctx).stdout);
  assert.equal(status.latestFinished.title, "Codex Dispatch: refactor");
});

test("dispatch jobs are not offered as rescue resume candidates", () => {
  const ctx = setupRepo("task-ok");
  const result = companion(["dispatch", "Investigate the flaky test."], ctx);
  assert.equal(result.status, 0, result.stderr);

  const candidate = JSON.parse(companion(["task-resume-candidate", "--json"], ctx).stdout);
  assert.equal(candidate.available, false);
});

test("dispatch checkpoints a long run with a NEXT command that wait resumes", () => {
  const ctx = setupRepo("interruptible-slow-task");
  const pending = companion(["dispatch", "--timeout", "1s", "Run the slow migration."], ctx);

  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /Codex dispatch dispatch-\S+ is still (queued|running)/);
  const next = pending.stdout.trim().split("\n").at(-1);
  assert.match(next, /^NEXT: node ".+codex-companion\.mjs" wait dispatch-\S+ --cwd ".+"$/);

  const jobId = next.match(/wait (dispatch-\S+)/)[1];
  const finished = companion(["wait", jobId, "--timeout", "20s"], ctx);
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(finished.stdout, /^Handled the requested task\./);
  assert.match(finished.stdout, new RegExp(`job ${jobId}`));
  assert.doesNotMatch(finished.stdout, /NEXT:/);
});

test("dispatch --timeout 0 returns immediately with the job id", () => {
  const ctx = setupRepo("interruptible-slow-task");
  const launched = companion(["dispatch", "--timeout", "0", "--json", "Run the slow migration."], ctx);

  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  assert.equal(payload.status, "queued");
  assert.match(payload.next, /wait dispatch-/);

  const finished = companion(["wait", payload.jobId, "--timeout", "20s", "--json"], ctx);
  assert.equal(JSON.parse(finished.stdout).status, "completed");
});

test("stopping a waiting dispatch cancels the Codex job", async () => {
  const ctx = setupRepo("interruptible-slow-task");
  const child = spawn("node", [SCRIPT, "dispatch", "--timeout", "30s", "Run the slow migration."], {
    cwd: ctx.repo,
    env: ctx.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = JSON.parse(companion(["status", "--json"], ctx).stdout);
    if (status.running.some((job) => job.turnId)) {
      break;
    }
    assert.ok(Date.now() < deadline, "dispatch never started its turn");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.kill("SIGTERM");
  });

  assert.equal(exitCode, 143);
  assert.match(stderr, /Cancelled Codex dispatch dispatch-\S+ \(SIGTERM\)/);
  const status = JSON.parse(companion(["status", "--json"], ctx).stdout);
  assert.equal(status.running.length, 0);
  assert.equal(status.latestFinished.status, "cancelled");
  assert.match(status.latestFinished.errorMessage, /received SIGTERM/);
  assert.ok(ctx.readFakeState().lastInterrupt, "expected a turn/interrupt request");
});

test("dispatch rejects resuming a job that is still running", () => {
  const ctx = setupRepo("interruptible-slow-task");
  const launched = JSON.parse(companion(["dispatch", "--timeout", "0", "--json", "Run the slow migration."], ctx).stdout);

  const followUp = companion(["dispatch", "--resume", launched.jobId, "and then?"], ctx);
  assert.equal(followUp.status, 1);
  assert.match(followUp.stderr, /is still (queued|running)/);

  companion(["cancel", launched.jobId], ctx);
});
