import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { killStaleBroker, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

test("an idle broker shuts down, removes its session directory, and forgets itself", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(review.status, 0, review.stderr);

  const session = loadBrokerSession(repo);
  assert.ok(session?.pid, "expected the review to start a shared broker");
  assert.ok(fs.existsSync(session.sessionDir));

  // helpers.mjs sets CODEX_COMPANION_BROKER_IDLE_MS=1500 for test runs.
  assert.equal(await waitUntil(() => !isAlive(session.pid)), true, "broker did not exit after going idle");
  assert.equal(fs.existsSync(session.sessionDir), false);
  assert.equal(loadBrokerSession(repo), null);
});

test("killStaleBroker kills a broker process but spares a pid that now belongs to something else", async () => {
  const keepAlive = "setTimeout(() => {}, 30000)";
  const unrelated = spawn(process.execPath, ["-e", keepAlive], { detached: true, stdio: "ignore" });
  const broker = spawn(process.execPath, ["-e", keepAlive, "app-server-broker.mjs", "serve"], { detached: true, stdio: "ignore" });

  try {
    killStaleBroker(unrelated.pid);
    killStaleBroker(broker.pid);

    assert.equal(await waitUntil(() => !isAlive(broker.pid), 5000), true, "broker-looking process was not killed");
    assert.equal(isAlive(unrelated.pid), true, "an unrelated process was killed");
  } finally {
    for (const child of [unrelated, broker]) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});
