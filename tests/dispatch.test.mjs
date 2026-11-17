import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  attributeWorkingTreeChanges,
  isTransientCodexError,
  resolveDispatchRetryDelays,
  parseDuration,
  renderDispatchReport,
  renderDispatchUnfinished,
  splitDispatchDirectives,
  summarizeCommands,
  summarizeFileChanges
} from "../plugins/codex/scripts/lib/dispatch.mjs";

import { analyzeShellCommand, isCompoundCommand, unwrapShellCommand } from "../plugins/codex/scripts/lib/shell-command.mjs";

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
  assert.match(rendered, /Commands reported: 20, 2 with non-zero exit \(commands and edits the sandbox refused are not reported\)\n {2}\(showing 7:/);
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
  assert.match(rendered, /Files changed during the run: none/);
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
    /Commands reported: 3, 1 with non-zero exit \(commands and edits the sandbox refused are not reported\)\n {2}✗ npm test \(exit 1\)\n {2}✓ npm test \(exit 0\)\n {2}✓ rg -n handler src \(exit 0\)/
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
  assert.match(result.stdout, /Files changed during the run: none \(read-only run\)/);
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
  assert.match(pending.stdout, /collect the report later with \/codex:result dispatch-\S+ \(progress: \/codex:status dispatch-\S+\)\.\nNEXT: /);

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
  let workerPid = null;
  for (;;) {
    const status = JSON.parse(companion(["status", "--json"], ctx).stdout);
    const started = status.running.find((job) => job.turnId);
    if (started) {
      workerPid = started.pid;
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
  // The turn runs on the worker's own app-server, so killing the worker ends it; no other
  // app-server is asked to interrupt a thread it does not know.
  assert.equal(ctx.readFakeState().lastInterrupt ?? null, null);
  let workerAlive = true;
  for (let attempt = 0; attempt < 30 && workerAlive; attempt += 1) {
    try {
      process.kill(workerPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      workerAlive = false;
    }
  }
  assert.equal(workerAlive, false, "the Codex worker survived the cancel");
});

test("dispatch rejects resuming a job that is still running", () => {
  const ctx = setupRepo("interruptible-slow-task");
  const launched = JSON.parse(companion(["dispatch", "--timeout", "0", "--json", "Run the slow migration."], ctx).stdout);

  const followUp = companion(["dispatch", "--resume", launched.jobId, "and then?"], ctx);
  assert.equal(followUp.status, 1);
  assert.match(followUp.stderr, /is still (queued|running)/);

  companion(["cancel", launched.jobId], ctx);
});

test("dispatch runs a family name on the newest model Codex lists and accepts the newer effort levels", () => {
  const ctx = setupRepo("task-ok");
  const result = companion(["dispatch"], ctx, "--model sol --effort ultra\nAudit the parser.");

  assert.equal(result.status, 0, result.stderr);
  const state = ctx.readFakeState();
  assert.equal(state.lastTurnStart.model, "gpt-9.10-sol");
  assert.equal(state.lastTurnStart.effort, "ultra");
  assert.match(result.stdout, /^Model: gpt-9\.10-sol · effort ultra$/m);
});

test("the evidence names the model Codex ran when the dispatch chose none", () => {
  const ctx = setupRepo("task-ok");
  const result = companion(["dispatch", "Audit the parser."], ctx);

  assert.equal(result.status, 0, result.stderr);
  // The plugin sent no model, so this is the fake Codex's own default.
  assert.equal(ctx.readFakeState().lastTurnStart.model, null);
  assert.match(result.stdout, /^Model: gpt-5\.4$/m);
});

test("dispatch runs a family name on the built-in model when Codex's model list cannot be read", () => {
  const ctx = setupRepo("model-list-fails");
  const result = companion(["dispatch", "--json"], ctx, "--model sol\nAudit the parser.");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.readFakeState().lastTurnStart.model, "gpt-6.2-sol");

  const { jobId } = JSON.parse(result.stdout);
  const settings = JSON.parse(companion(["troubleshoot", jobId, "--json"], ctx).stdout).job.settings;
  assert.equal(settings.model, "gpt-6.2-sol");
  assert.equal(settings.modelFrom, "sol: the plugin's built-in id, because Codex's model list could not be read: failed to load models");
});

test("dispatch defaults to CODEX_DISPATCH_MODEL/EFFORT and the directive line overrides them", () => {
  const ctx = setupRepo("task-ok");
  const env = { ...ctx.env, CODEX_DISPATCH_MODEL: "astra", CODEX_DISPATCH_EFFORT: "high" };

  const defaulted = companion(["dispatch", "Audit the parser."], { ...ctx, env });
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.equal(ctx.readFakeState().lastTurnStart.model, "gpt-9-astra");
  assert.equal(ctx.readFakeState().lastTurnStart.effort, "high");
  assert.equal(ctx.readFakeState().modelListRequests, 1);

  const overridden = companion(["dispatch"], { ...ctx, env }, "--model gpt-6-luna --effort max\nAudit it again.");
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(ctx.readFakeState().lastTurnStart.model, "gpt-6-luna");
  assert.equal(ctx.readFakeState().lastTurnStart.effort, "max");
  // A model id is used as given: nothing is looked up.
  assert.equal(ctx.readFakeState().modelListRequests, 1);
});

test("dispatch gives write runs network access and keeps read-only runs offline by default", () => {
  const ctx = setupRepo("task-ok");

  assert.equal(companion(["dispatch", "Run the integration tests."], ctx).status, 0);
  let state = ctx.readFakeState();
  assert.deepEqual(state.lastTurnStart.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  });
  assert.deepEqual(state.lastThreadStart.config, { allow_login_shell: false });
  assert.match(state.lastTurnStart.prompt, /Network access is on/);

  const readOnly = companion(["dispatch"], ctx, "--read-only\nExplain the retry logic.");
  assert.match(readOnly.stdout, /Sandbox: read-only · network off/);
  state = ctx.readFakeState();
  assert.deepEqual(state.lastTurnStart.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.match(state.lastTurnStart.prompt, /Network access is off/);
});

test("dispatch --network and --no-network override the sandbox default", () => {
  const ctx = setupRepo("task-ok");

  assert.equal(companion(["dispatch"], ctx, "--read-only --network\nQuery the local test database.").status, 0);
  assert.deepEqual(ctx.readFakeState().lastTurnStart.sandboxPolicy, { type: "readOnly", networkAccess: true });

  assert.equal(companion(["dispatch"], ctx, "--no-network\nRefactor the parser.").status, 0);
  assert.equal(ctx.readFakeState().lastTurnStart.sandboxPolicy.networkAccess, false);

  const conflict = companion(["dispatch"], ctx, "--network --no-network\nRefactor the parser.");
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Choose either --network or --no-network/);
});

test("follow-up dispatches keep the non-login shell config", () => {
  const ctx = setupRepo("task-ok");
  const first = JSON.parse(companion(["dispatch", "--json", "Refactor the parser."], ctx).stdout);
  assert.equal(companion(["dispatch", "--resume", first.jobId, "follow up: add tests"], ctx).status, 0);
  assert.deepEqual(ctx.readFakeState().lastThreadResume.config, { allow_login_shell: false });
});

test("a follow-up inherits the resumed run's sandbox, network, model, effort, and framing", () => {
  const ctx = setupRepo("task-ok");
  const first = JSON.parse(
    companion(["dispatch", "--json"], ctx, "--read-only --network --model astra --effort max --raw\nAudit the cache.").stdout
  );

  // A relay forwards only the follow-up message; it must not silently become a write run.
  const followUp = companion(["dispatch", "--resume", first.jobId, "follow up: check the eviction path too"], ctx);
  assert.equal(followUp.status, 0, followUp.stderr);
  const state = ctx.readFakeState();
  assert.equal(state.lastThreadResume.sandbox, "read-only");
  assert.deepEqual(state.lastTurnStart.sandboxPolicy, { type: "readOnly", networkAccess: true });
  // The thread stays on the model it started with: the follow-up does not look for a newer one.
  assert.equal(state.lastTurnStart.model, "gpt-9-astra");
  assert.equal(state.modelListRequests, 1);
  assert.equal(state.lastTurnStart.effort, "max");
  assert.equal(state.lastTurnStart.prompt, "follow up: check the eviction path too");

  const overridden = companion(["dispatch", "--resume", followUp.stdout.match(/--resume (dispatch-\S+)/)[1]], ctx, "--write\nnow apply the fix");
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(ctx.readFakeState().lastTurnStart.sandboxPolicy.type, "workspaceWrite");
  assert.equal(ctx.readFakeState().lastTurnStart.sandboxPolicy.networkAccess, true);
});

test("dispatch reads the task from a --prompt-file directive", () => {
  const ctx = setupRepo("task-ok");
  const assignment = "# Assignment L3\nReport in the format below.\nCODEX_DISPATCH_PROMPT_EOF is just text here.\n";
  fs.writeFileSync(path.join(ctx.repo, "assignment.md"), assignment);

  const result = companion(["dispatch"], ctx, "--prompt-file assignment.md --raw --label L3\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ctx.readFakeState().lastTurnStart.prompt, assignment.trim());

  const both = companion(["dispatch"], ctx, "--prompt-file assignment.md\nAlso do this.");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /either --prompt-file or inline task text/);
});

test("--timeout is not accepted as a directive", () => {
  const ctx = setupRepo("task-ok");
  const result = companion(["dispatch"], ctx, "--timeout 10m\nRun the slow suite.");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported dispatch directive: --timeout/);
});

test("--writable-root adds directories a write run may change", () => {
  const ctx = setupRepo("task-ok");
  const scratch = fs.realpathSync(makeTempDir());
  const result = companion(["dispatch"], ctx, `--writable-root ${scratch}\nGenerate fixtures.`);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Sandbox: workspace-write \\+ ${scratch} · network on`));
  const state = ctx.readFakeState();
  assert.deepEqual(state.lastTurnStart.sandboxPolicy.writableRoots, [scratch]);
  assert.match(state.lastTurnStart.prompt, new RegExp(`You may also write in: ${scratch}`));
});

test("a read-only run with a writable root keeps the repository read-only and runs from the scratch directory", () => {
  const ctx = setupRepo("task-ok");
  const scratch = fs.realpathSync(makeTempDir());
  const result = companion(["dispatch"], ctx, `--read-only --writable-root ${scratch} --network\nReview the branch; put notes in the scratch dir.`);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Sandbox: read-only repository, writable: ${scratch} · network on · cwd: ${scratch}`));
  const state = ctx.readFakeState();
  assert.equal(state.lastThreadStart.cwd, scratch);
  // The test repository lives under /tmp, so /tmp must not be writable.
  assert.deepEqual(state.lastTurnStart.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true
  });
  assert.match(state.lastTurnStart.prompt, new RegExp(`repository at ${fs.realpathSync(ctx.repo)} is read-only`));
});

test("a writable root that contains the repository or does not exist is rejected", () => {
  const ctx = setupRepo("task-ok");
  const parent = companion(["dispatch"], ctx, `--read-only --writable-root ${path.dirname(ctx.repo)}\nReview.`);
  assert.equal(parent.status, 1);
  assert.match(parent.stderr, /contains the repository/);

  const missing = companion(["dispatch"], ctx, "--writable-root ./no-such-dir\nWrite fixtures.");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not an existing directory/);
});

test("CODEX_DISPATCH_NETWORK and CODEX_DISPATCH_WRITABLE_ROOTS set defaults that directives override", () => {
  const ctx = setupRepo("task-ok");
  const scratch = fs.realpathSync(makeTempDir());
  const env = { ...ctx.env, CODEX_DISPATCH_NETWORK: "off", CODEX_DISPATCH_WRITABLE_ROOTS: scratch };

  assert.equal(companion(["dispatch", "Refactor."], { ...ctx, env }).status, 0);
  let policy = ctx.readFakeState().lastTurnStart.sandboxPolicy;
  assert.equal(policy.networkAccess, false);
  assert.deepEqual(policy.writableRoots, [scratch]);

  assert.equal(companion(["dispatch"], { ...ctx, env }, "--network\nRun the database tests.").status, 0);
  assert.equal(ctx.readFakeState().lastTurnStart.sandboxPolicy.networkAccess, true);
});

test("command evidence unwraps non-login shells and shows multi-line scripts on one line", () => {
  const [single, script] = summarizeCommands([
    { command: "/bin/bash -c ls", exitCode: 0, status: "completed" },
    { command: "/bin/bash -c 'printf hi > a.txt\nrm b.txt\nls'", exitCode: 0, status: "completed" }
  ]);
  assert.equal(single.command, "ls");
  const rendered = renderDispatchReport({ status: "completed", jobId: "d", write: true, cwd: "/r", finalMessage: "ok", files: [], commands: [single, script] });
  assert.match(rendered, /\? printf hi > a\.txt; rm b\.txt; ls \(exit 0 from the last command only\)/);
});

test("jobs run in another workspace are found from this one by id, and listed for this session", () => {
  const ctx = setupRepo("task-ok");
  const other = makeTempDir();
  initGitRepo(other);
  const env = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-cross" };

  const launched = JSON.parse(companion(["dispatch", "--json"], { ...ctx, env }, `--cwd ${other} --label elsewhere\nAudit the other repo.`).stdout);
  assert.equal(launched.status, "completed");

  // The job lives in the other workspace's state, yet this workspace resolves it by id.
  assert.equal(companion(["result", launched.jobId, "--json"], { ...ctx, env }).status, 0);
  const waited = JSON.parse(companion(["wait", launched.jobId, "--json"], { ...ctx, env }).stdout);
  assert.equal(waited.status, "completed");

  const status = JSON.parse(companion(["status", "--json"], { ...ctx, env }).stdout);
  assert.equal(status.latestFinished.id, launched.jobId);
  assert.equal(status.latestFinished.otherWorkspace, true);
  assert.match(companion(["status"], { ...ctx, env }).stdout, new RegExp(`Workspace: ${other}`));

  // Another session's jobs from other workspaces stay out of this session's status.
  const foreign = JSON.parse(companion(["status", "--json"], { ...ctx, env: { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-other" } }).stdout);
  assert.equal(foreign.latestFinished, null);
});

test("a running job in another workspace can be cancelled from this one", () => {
  const ctx = setupRepo("interruptible-slow-task");
  const other = makeTempDir();
  initGitRepo(other);

  const launched = JSON.parse(companion(["dispatch", "--timeout", "0", "--json"], ctx, `--cwd ${other}\nRun the slow migration.`).stdout);
  const cancelled = companion(["cancel", launched.jobId, "--json"], ctx);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

  const result = companion(["result", launched.jobId, "--json"], ctx);
  assert.equal(JSON.parse(result.stdout).job.status, "cancelled");
});

test("--worktree runs Codex in its own worktree and branch, leaving the main checkout untouched", () => {
  const ctx = setupRepo("with-file-write");
  const result = companion(["dispatch", "--json"], ctx, "--worktree --label 'fix flaky test'\nFix the flaky test.");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const worktree = payload.report.worktree;

  assert.equal(worktree.removed, false);
  assert.match(worktree.branch, new RegExp(`^codex-dispatch/${payload.jobId}-fix-flaky-test$`));
  assert.equal(ctx.readFakeState().lastThreadStart.cwd, worktree.path);
  assert.equal(fs.readFileSync(path.join(worktree.path, "codex-output.txt"), "utf8"), "written by fake codex\n");
  assert.equal(fs.existsSync(path.join(ctx.repo, "codex-output.txt")), false);
  assert.equal(run("git", ["status", "--porcelain"], { cwd: ctx.repo }).stdout, "");
  assert.deepEqual(payload.report.files, [{ path: "codex-output.txt", change: "added" }]);

  const rendered = companion(["result", payload.jobId], ctx).stdout;
  assert.match(rendered, new RegExp(`Worktree: ${worktree.path} · branch ${worktree.branch}`));
  assert.match(rendered, /Keep: git -C .+ add -A && git -C .+ commit -m "<message>" && git -C .+ merge codex-dispatch\//);

  // The follow-up continues in the same worktree.
  assert.equal(companion(["dispatch", "--resume", payload.jobId, "follow up: also update the docs"], ctx).status, 0);
  assert.equal(ctx.readFakeState().lastThreadResume.cwd, worktree.path);
  assert.equal(fs.readFileSync(path.join(worktree.path, "codex-output.txt"), "utf8"), "written by fake codex\n".repeat(2));
});

test("--worktree removes the worktree and branch when Codex changed nothing", () => {
  const ctx = setupRepo("task-ok");
  const payload = JSON.parse(companion(["dispatch", "--json"], ctx, "--worktree\nCheck whether the cache needs a fix.").stdout);
  const worktree = payload.report.worktree;

  assert.equal(worktree.removed, true);
  assert.equal(fs.existsSync(worktree.path), false);
  assert.equal(run("git", ["branch", "--list", worktree.branch], { cwd: ctx.repo }).stdout.trim(), "");
  assert.match(companion(["result", payload.jobId], ctx).stdout, /\(removed: the run changed nothing\)/);
});

test("--worktree is refused for a new read-only run and outside a git repository", () => {
  const ctx = setupRepo("task-ok");
  const readOnly = companion(["dispatch"], ctx, "--read-only --worktree\nReview.");
  assert.equal(readOnly.status, 1);
  assert.match(readOnly.stderr, /--worktree is for write runs/);

  const plain = makeTempDir();
  const outside = companion(["dispatch"], ctx, `--cwd ${plain} --worktree\nFix it.`);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /Could not start a worktree/);
});

test("isCompoundCommand flags lines whose exit code is only the last command's", () => {
  const compound = [
    "touch x; echo exit=$?",
    "pnpm test 2>&1 | tail -20",
    "make || true",
    "printf hi > a\nrm b",
    "cat <<EOF | sh\nx\nEOF"
  ];
  const single = [
    "npm test",
    "cd web && pnpm test",
    'echo "a;b|c"',
    "grep -E 'a|b' file",
    String.raw`echo a\;b`,
    "cat <<'EOF' > notes.md\nline; with | separators\nEOF"
  ];
  for (const command of compound) {
    assert.equal(isCompoundCommand(command), true, command);
  }
  for (const command of single) {
    assert.equal(isCompoundCommand(command), false, command);
  }
});

test("a ? marks an exit code that leaves out a part that matters, and says which", () => {
  const commands = summarizeCommands([
    { command: "/bin/bash -c 'touch /ro/x; echo exit=$?'", exitCode: 0, status: "completed" },
    { command: "/bin/bash -c 'pnpm test 2>&1 | tail -5'", exitCode: 1, status: "failed" },
    { command: "/bin/bash -c 'cd web && pnpm test'", exitCode: 0, status: "completed" },
    { command: "/bin/bash -c 'pnpm test 2>&1 | tail -5'", exitCode: 0, status: "completed" },
    { command: "/bin/bash -c 'set -a; . ./.env.test-db; set +a; pnpm exec vitest run src/a.test.ts'", exitCode: 0, status: "completed" },
    { command: "/bin/bash -c \"sed -n 1,80p src/a.test.ts; rg -n 'test|build' src; cat notes.md\"", exitCode: 0, status: "completed" },
    { command: "/bin/bash -c 'pnpm lint > /tmp/lint.log 2>&1; rc=$?; tail -20 /tmp/lint.log; exit \"$rc\"'", exitCode: 0, status: "completed" }
  ]);
  const rendered = renderDispatchReport({ status: "completed", jobId: "d", write: true, cwd: "/r", finalMessage: "ok", files: [], commands });
  assert.match(rendered, /\? touch \/ro\/x; echo exit=\$\? \(exit 0 from the last command only\)/);
  assert.match(rendered, /✗ pnpm test 2>&1 \| tail -5 \(exit 1 from the last command only\)/);
  assert.match(rendered, /✓ cd web && pnpm test \(exit 0\)/);
  assert.match(rendered, /\? pnpm test 2>&1 \| tail -5 \(exit 0, but not from `pnpm test 2>&1`\)/);
  assert.match(rendered, /✓ set -a; \. \.\/\.env\.test-db; set \+a; pnpm exec vitest run src\/a\.test\.ts \(exit 0 from the last command\)/);
  assert.match(rendered, /✓ sed -n 1,80p src\/a\.test\.ts; rg -n 'test\|build' src; cat notes\.md \(exit 0\)/);
  assert.match(rendered, /✓ pnpm lint > \/tmp\/lint\.log 2>&1; rc=\$\?; tail -20 \/tmp\/lint\.log; exit "\$rc" \(exit 0\)/);
});

test("the exit code covers a line when the shell stops at the first failure or hands the status on", () => {
  const covered = [
    "npm test",
    "pnpm lint && pnpm test",
    "set -euo pipefail\npnpm lint\npnpm test | tee /tmp/test.log",
    "(cd web && pnpm test) > /tmp/web.log 2>&1",
    "{ pnpm lint && pnpm typecheck; } > /tmp/checks.log 2>&1"
  ];
  for (const command of covered) {
    assert.deepEqual(analyzeShellCommand(command), { compound: false, unchecked: null, verification: true }, command);
  }

  const hidden = [
    ["pnpm test || true", "pnpm test"],
    ["pnpm lint; pnpm test", "pnpm lint"],
    ["set -e\npnpm test | tee /tmp/test.log", "pnpm test"],
    ["set -e\npnpm lint && echo linted\npnpm test", "pnpm lint"],
    ["pnpm lint > a.log 2>&1; rc=$?; pnpm test; exit $rc", "pnpm test"],
    ["git status --short; git diff --check; git log -1", "git diff --check"],
    ["(pnpm lint; pnpm test) > /tmp/all.log 2>&1", "pnpm lint"],
    ["timeout 120 pnpm test; echo done", "timeout 120 pnpm test"]
  ];
  for (const [command, unchecked] of hidden) {
    assert.deepEqual(analyzeShellCommand(command).unchecked, { kind: "verification", command: unchecked }, command);
  }

  // A script with a loop or a conditional decides its own exit code: only that it has several commands is known.
  assert.deepEqual(analyzeShellCommand("for f in a b; do pnpm test $f; done"), { compound: true, unchecked: { kind: "other" }, verification: true });
  assert.deepEqual(analyzeShellCommand("if test -e x; then ls x; fi"), { compound: true, unchecked: { kind: "other" }, verification: false });
});

test("only commands run for their result count as test, build, or lint runs", () => {
  const verification = [
    "npm test -- --grep auth",
    "pnpm --filter @tyxter/dashboard exec vitest run src/features/a.test.ts",
    "npm_config_manage_package_manager_versions=false pnpm l010:check > /tmp/gate.log 2>&1",
    "env -u CI pnpm typecheck",
    "npx prettier --check src",
    "node --test tests/*.test.mjs",
    "node scripts/gates/check-ownership.mjs --inventory",
    "python3 -m pytest -q",
    "cargo clippy --all-targets",
    "git diff --check",
    "./node_modules/.bin/tsc -p tsconfig.json"
  ];
  const other = [
    "sed -n '1,120p' src/auth/session.test.ts",
    "rg -n 'test|build|lint' src",
    "cat tests/fixtures/build.json",
    "git diff -- src/a.test.ts",
    "tail -20 /tmp/test.log",
    "python3 - <<'PY'\nprint('running the test build check')\nPY",
    "node -e 'console.log(\"lint and test passed\")'",
    "npx prettier --write src/a.test.ts",
    "cp src/a.test.ts src/b.test.ts",
    "pgrep -af 'vitest run'",
    "pnpm install --frozen-lockfile"
  ];
  for (const command of verification) {
    assert.equal(analyzeShellCommand(command).verification, true, command);
  }
  for (const command of other) {
    assert.equal(analyzeShellCommand(command).verification, false, command);
  }
});

test("unwrapping bash -c undoes its quoting, so quoted separators are not mistaken for compound commands", () => {
  const cases = [
    [String.raw`/bin/bash -c "python3 -c \"from pathlib import Path; print(Path('a').read_text())\""`, `python3 -c "from pathlib import Path; print(Path('a').read_text())"`],
    [String.raw`/bin/bash -c "printf 'first\\n' > long.txt"`, String.raw`printf 'first\n' > long.txt`],
    [String.raw`/bin/bash -lc 'echo '\''a; b'\'''`, `echo 'a; b'`],
    // Codex quotes an argument containing both quote kinds as several quoted parts.
    [
      `/bin/bash -c "rg -n '"'^export|''^function|''^(async )?function'"' plugins/codex/scripts/lib/state.mjs"`,
      `rg -n '^export|^function|^(async )?function' plugins/codex/scripts/lib/state.mjs`
    ],
    ["/bin/bash -c ls", "ls"]
  ];
  for (const [raw, expected] of cases) {
    assert.equal(unwrapShellCommand(raw), expected);
    assert.equal(isCompoundCommand(unwrapShellCommand(raw)), false, expected);
  }
  assert.equal(isCompoundCommand(unwrapShellCommand(String.raw`/bin/bash -c "touch x; echo \"done\""`)), true);
});

test("a follow-up from another directory runs where the resumed run ran, with its settings", () => {
  const ctx = setupRepo("task-ok");
  const other = makeTempDir();
  initGitRepo(other);
  fs.writeFileSync(path.join(other, "a.txt"), "a\n");
  run("git", ["add", "."], { cwd: other });
  run("git", ["commit", "-m", "init"], { cwd: other });

  const first = JSON.parse(
    companion(["dispatch", "--json"], ctx, `--cwd ${other} --read-only --network --model astra\nAudit the other repo.`).stdout
  );
  // The relay's shell sits in ctx.repo and forwards only the follow-up message.
  const followUp = companion(["dispatch", "--json", "--resume", first.jobId, "follow up: and the tests?"], ctx);
  assert.equal(followUp.status, 0, followUp.stderr);
  const report = JSON.parse(followUp.stdout).report;

  const state = ctx.readFakeState();
  assert.equal(state.lastThreadResume.cwd, other);
  assert.deepEqual(state.lastTurnStart.sandboxPolicy, { type: "readOnly", networkAccess: true });
  assert.equal(state.lastTurnStart.model, "gpt-9-astra");
  assert.equal(report.cwd, other);
  // The follow-up job is recorded with the work it continues, not in the caller's workspace.
  assert.equal(JSON.parse(companion(["result", JSON.parse(followUp.stdout).jobId, "--json", "--cwd", other], ctx).stdout).job.workspaceRoot, other);
});

test("only failed or cancelled dispatch reports point to /codex:troubleshoot", () => {
  const base = { jobId: "dispatch-9", threadId: "thr_9", write: true, cwd: "/r", finalMessage: "ok", files: [], commands: [] };
  assert.match(renderDispatchReport({ ...base, status: "failed", error: "boom" }), /^Diagnose: \/codex:troubleshoot dispatch-9$/m);
  assert.doesNotMatch(renderDispatchReport({ ...base, status: "completed" }), /Diagnose:/);
  assert.match(renderDispatchUnfinished({ id: "dispatch-9", status: "cancelled" }, null), /Diagnose: \/codex:troubleshoot dispatch-9/);
});

test("temporary service errors are told apart from errors that waiting does not fix", () => {
  for (const error of [
    { message: "The server is overloaded.", codexErrorInfo: "serverOverloaded" },
    { message: "stream disconnected before completion", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } },
    { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: null },
    { message: "stream disconnected before completion: Unable to verify model access right now. Please retry.", codexErrorInfo: "other" }
  ]) {
    assert.equal(isTransientCodexError(error), true, error.message);
  }
  for (const error of [
    { message: "You've hit your usage limit. Please retry in 3 hours.", codexErrorInfo: "usageLimitExceeded" },
    { message: "Your input exceeds the context window.", codexErrorInfo: "contextWindowExceeded" },
    { message: "401 Unauthorized", codexErrorInfo: "unauthorized" },
    { message: "Something else went wrong.", codexErrorInfo: null },
    { message: "You've hit your usage limit. Please retry at 3:00 PM.", codexErrorInfo: null },
    null
  ]) {
    assert.equal(isTransientCodexError(error), false, error?.message);
  }
});

test("CODEX_DISPATCH_RETRY_DELAYS sets the waits between retries, or turns retries off", () => {
  assert.deepEqual(resolveDispatchRetryDelays({}), [20_000, 60_000, 120_000]);
  assert.deepEqual(resolveDispatchRetryDelays({ CODEX_DISPATCH_RETRY_DELAYS: "5s, 1m" }), [5_000, 60_000]);
  assert.deepEqual(resolveDispatchRetryDelays({ CODEX_DISPATCH_RETRY_DELAYS: "off" }), []);
  assert.throws(() => resolveDispatchRetryDelays({ CODEX_DISPATCH_RETRY_DELAYS: "soon" }), /Invalid duration/);
  assert.throws(() => resolveDispatchRetryDelays({ CODEX_DISPATCH_RETRY_DELAYS: "5s,none" }), /Invalid CODEX_DISPATCH_RETRY_DELAYS/);

  const ctx = setupRepo("task-ok");
  const refused = companion(["dispatch", "Audit the parser."], { ...ctx, env: { ...ctx.env, CODEX_DISPATCH_RETRY_DELAYS: "soon" } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Invalid duration "soon"/);
});

test("a turn cut off by a temporary Codex error is continued on the same thread", () => {
  const ctx = setupRepo("transient-failure-once");
  const env = { ...ctx.env, CODEX_DISPATCH_RETRY_DELAYS: "50ms" };
  const result = companion(["dispatch", "--json", "Fix the parser."], { ...ctx, env });

  assert.equal(result.status, 0, result.stderr);
  const { report, jobId } = JSON.parse(result.stdout);
  assert.equal(report.status, "completed");
  assert.equal(report.finalMessage, "Handled the requested task.\nTask prompt accepted.");
  assert.deepEqual(report.retries, [{ error: "Selected model is at capacity. Please try a different model.", delayMs: 50 }]);
  // The cut-off turn's work stays in the evidence.
  assert.deepEqual(report.commands.map((entry) => [entry.command, entry.exitCode]), [["npm test", 1]]);

  const state = ctx.readFakeState();
  assert.equal(state.lastThreadResume.threadId, report.threadId);
  assert.match(state.lastTurnStart.prompt, /^<retry>\nYour previous turn in this thread was cut off by a temporary Codex service error: Selected model is at capacity\./);
  assert.match(state.lastTurnStart.prompt, /<task>\nFix the parser\.\n<\/task>/);

  const rendered = companion(["result", jobId], { ...ctx, env }).stdout;
  assert.match(rendered, /^Handled the requested task\./);
  assert.match(
    rendered,
    /Temporary Codex errors: 1 turn was cut off and continued on the same thread \(last: Selected model is at capacity\. Please try a different model\.\)/
  );
});

test("retries stop after the configured waits, and a failed run's progress note is not shown as its report", () => {
  const ctx = setupRepo("transient-failure-always");
  const env = { ...ctx.env, CODEX_DISPATCH_RETRY_DELAYS: "50ms,50ms" };
  const result = companion(["dispatch", "Fix the parser."], { ...ctx, env });

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /^Codex stopped before writing its report\. Error: stream disconnected before completion: Please retry\.\nIts last progress note, which is not a report:\n\nI am checking the parser before changing it\.\n/
  );
  assert.match(result.stdout, /Status: failed/);
  assert.match(result.stdout, /Temporary Codex errors: 2 turns were cut off and continued on the same thread; the last attempt failed too \(last: stream disconnected/);
  assert.match(result.stdout, /Commands reported: 3, 3 with non-zero exit/);
  assert.equal(ctx.readFakeState().failedTurns, 3);

  const status = JSON.parse(companion(["status", "--json"], { ...ctx, env }).stdout);
  assert.equal(status.latestFinished.summary, "stream disconnected before completion: Please retry.");
});

test("an error that waiting does not fix, and any error with retries off, fails the run at once", () => {
  const limited = setupRepo("usage-limit-failure");
  const first = companion(["dispatch", "Fix the parser."], { ...limited, env: { ...limited.env, CODEX_DISPATCH_RETRY_DELAYS: "50ms" } });
  assert.equal(first.status, 1);
  assert.match(first.stdout, /Error: You've hit your usage limit\./);
  assert.doesNotMatch(first.stdout, /Temporary Codex errors/);
  assert.equal(limited.readFakeState().failedTurns, 1);

  const off = setupRepo("transient-failure-once");
  const second = companion(["dispatch", "Fix the parser."], { ...off, env: { ...off.env, CODEX_DISPATCH_RETRY_DELAYS: "off" } });
  assert.equal(second.status, 1);
  assert.equal(off.readFakeState().failedTurns, 1);
});

test("a read-only run reports files that changed in the repository as not its own", () => {
  // The fake Codex is not sandboxed, so its write stands in for another writer in the checkout.
  const ctx = setupRepo("with-file-write");
  const result = companion(["dispatch", "--json"], ctx, "--read-only\nReview the branch.");
  assert.equal(result.status, 0, result.stderr);
  const { report, jobId } = JSON.parse(result.stdout);
  assert.deepEqual(report.files, []);
  assert.deepEqual(report.otherFiles, [{ path: "codex-output.txt", change: "added" }]);

  const rendered = companion(["result", jobId], ctx).stdout;
  assert.match(
    rendered,
    /Files changed during the run: none \(read-only run\)\nChanged in the repository meanwhile, not by this run \(1\):\n {2}added: codex-output\.txt\n/
  );
});

test("a read-only run keeps changes inside its writable roots as its own, and a write run keeps them all", () => {
  const ctx = setupRepo("with-file-write");
  const scratch = path.join(fs.realpathSync(ctx.repo), "scratch");
  fs.mkdirSync(scratch);
  const reviewer = companion(["dispatch", "--json"], ctx, `--read-only --writable-root ${scratch}\nReview the branch; put notes in the scratch dir.`);
  assert.equal(reviewer.status, 0, reviewer.stderr);
  const reviewerReport = JSON.parse(reviewer.stdout).report;
  assert.deepEqual(reviewerReport.files, [{ path: "scratch/codex-output.txt", change: "added" }]);
  assert.deepEqual(reviewerReport.otherFiles, []);

  const changes = [
    { path: "src/app.js", change: "modified" },
    { path: "scratch/notes.md", change: "added" }
  ];
  const root = fs.realpathSync(ctx.repo);
  assert.deepEqual(attributeWorkingTreeChanges(changes, { mode: "read-only-with-scratch", writableRoots: [scratch] }, root), {
    own: [changes[1]],
    others: [changes[0]]
  });
  assert.deepEqual(attributeWorkingTreeChanges(changes, { mode: "read-only", writableRoots: [] }, root), { own: [], others: changes });
  assert.deepEqual(attributeWorkingTreeChanges(changes, { mode: "write", writableRoots: [] }, root), { own: changes, others: [] });
  // Outside a git repository there is no working-tree diff to attribute.
  assert.deepEqual(attributeWorkingTreeChanges(null, { mode: "read-only", writableRoots: [] }, root), { own: null, others: [] });
});

test("a long list of other writers' changes is cut short", () => {
  const otherFiles = Array.from({ length: 8 }, (_, index) => ({ path: `src/file-${index}.js`, change: "modified" }));
  const rendered = renderDispatchReport({ status: "completed", jobId: "dispatch-7", write: false, cwd: "/r", finalMessage: "ok", files: [], otherFiles, commands: [] });
  assert.match(rendered, /not by this run \(8\):\n(?: {2}modified: src\/file-\d\.js\n){5} {2}\.\.\. and 3 more\n/);
});
