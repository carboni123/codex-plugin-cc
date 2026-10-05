import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const LOADED_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8")).version;

function setup() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-ok");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // An isolated Claude config and Codex home, so the test reads neither the developer's install nor sessions.
  const claudeConfig = makeTempDir();
  const codexHome = makeTempDir();
  const env = { ...buildEnv(binDir), CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome };
  return { repo, env, claudeConfig, codexHome };
}

function companion(ctx, args, input) {
  return run("node", [SCRIPT, ...args], { cwd: ctx.repo, env: ctx.env, input });
}

function installRecord(ctx, version) {
  const dir = path.join(ctx.claudeConfig, "plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "codex@my-market": [{ version, installPath: `/cache/codex/${version}` }] } })
  );
}

test("troubleshoot <job-id> shows the job's settings, activity log, Codex session file, and stored report", () => {
  const ctx = setup();
  const job = JSON.parse(companion(ctx, ["dispatch", "--json"], "--read-only --label diag\nAudit the parser.").stdout);
  const sessionDir = path.join(ctx.codexHome, "sessions", "2026", "10", "05");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `rollout-2026-10-05T10-00-00-${job.report.threadId}.jsonl`);
  fs.writeFileSync(sessionFile, "{}\n");

  const result = companion(ctx, ["troubleshoot", job.jobId, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  assert.equal(report.job.id, job.jobId);
  assert.equal(report.job.status, "completed");
  assert.equal(report.job.settings.write, false);
  assert.deepEqual(report.job.settings.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(report.job.codexSessionFile, sessionFile);
  assert.ok(report.job.logTail.length > 0);
  assert.ok(report.job.logTail.every((line) => /^\[\d{4}-\d{2}-\d{2}T/.test(line)), "log tail holds only timestamped activity");
  assert.match(report.job.rendered, /Codex dispatch evidence/);
  assert.ok(report.knownLimitations.length >= 5);
  assert.equal(report.plugin.repository, "https://github.com/carboni123/codex-plugin-cc");
});

test("troubleshoot flags a session running an older plugin version than the one installed", () => {
  const ctx = setup();
  installRecord(ctx, "99.0.0");
  const rendered = companion(ctx, ["troubleshoot"]).stdout;
  assert.match(rendered, new RegExp(`Loaded in this session: ${LOADED_VERSION.replace(/\./g, "\\.")}`));
  assert.match(rendered, /Installed: 99\.0\.0 \(\/cache\/codex\/99\.0\.0\), marketplace my-market/);
  assert.match(rendered, /older version than the one installed\. Run \/reload-plugins/);
  assert.match(rendered, /claude plugin marketplace update my-market && claude plugin update codex@my-market/);

  installRecord(ctx, LOADED_VERSION);
  assert.doesNotMatch(companion(ctx, ["troubleshoot"]).stdout, /older version/);
});

test("troubleshoot names the local plugin source from CODEX_PLUGIN_SOURCE", () => {
  const ctx = setup();
  assert.match(companion(ctx, ["troubleshoot"]).stdout, /Local source: not configured \(set CODEX_PLUGIN_SOURCE/);

  const source = makeTempDir();
  initGitRepo(source);
  fs.mkdirSync(path.join(source, "plugins", "codex", ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(source, "plugins", "codex", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.3" }));
  run("git", ["add", "."], { cwd: source });
  run("git", ["commit", "-m", "plugin source"], { cwd: source });
  fs.writeFileSync(path.join(source, "work-in-progress.txt"), "x\n");

  const rendered = run("node", [SCRIPT, "troubleshoot"], { cwd: ctx.repo, env: { ...ctx.env, CODEX_PLUGIN_SOURCE: source } }).stdout;
  assert.match(rendered, new RegExp(`Local source \\(CODEX_PLUGIN_SOURCE\\): ${source} · version 1\\.2\\.3 · branch main · \\w+ plugin source · 1 uncommitted change\\(s\\)`));
});

test("troubleshoot without a job id lists recent jobs and how to dig into one", () => {
  const ctx = setup();
  const job = JSON.parse(companion(ctx, ["dispatch", "--json"], "Audit the parser.").stdout);
  const rendered = companion(ctx, ["troubleshoot"]).stdout;
  assert.match(rendered, new RegExp(`- ${job.jobId} · dispatch · completed`));
  assert.match(rendered, /Run `\/codex:troubleshoot <job-id>`/);
  assert.match(rendered, /## Known limitations/);
});
