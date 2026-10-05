import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  updateState,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_MODULE_URL = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("updateState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  updateState(workspace, () => {});

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("concurrent job updates from several processes keep every job and its files", async () => {
  const workspace = makeTempDir();
  const workers = 8;
  // Workers start together so their updates overlap; each records its job and then several
  // progress updates, the pattern of parallel dispatches.
  const startAt = Date.now() + 500;
  const script = `
    import { upsertJob, writeJobFile } from ${JSON.stringify(STATE_MODULE_URL)};
    const [workspace, id] = process.argv.slice(1);
    while (Date.now() < ${startAt}) {}
    writeJobFile(workspace, id, { id, status: "queued" });
    upsertJob(workspace, { id, status: "queued" });
    for (let step = 0; step < 10; step += 1) {
      upsertJob(workspace, { id, status: "running", phase: "step-" + step });
    }
  `;
  const exitCodes = await Promise.all(
    Array.from({ length: workers }, (_, index) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, workspace, `job-${index}`], {
          stdio: "inherit"
        });
        child.on("exit", resolve);
      })
    )
  );
  assert.deepEqual(exitCodes, Array(workers).fill(0));

  const expectedIds = Array.from({ length: workers }, (_, index) => `job-${index}`).sort();
  const savedState = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.deepEqual(savedState.jobs.map((job) => job.id).sort(), expectedIds);
  assert.deepEqual(savedState.jobs.map((job) => job.phase), Array(workers).fill("step-9"));
  assert.deepEqual(
    fs.readdirSync(resolveJobsDir(workspace)).sort(),
    expectedIds.map((id) => `${id}.json`)
  );
  assert.equal(fs.existsSync(`${resolveStateFile(workspace)}.lock`), false);
});

test("a state lock left by a process that died is taken over", () => {
  const workspace = makeTempDir();
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  const lockFile = `${resolveStateFile(workspace)}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, `${deadPid} abandoned`, "utf8");

  const startedAt = Date.now();
  upsertJob(workspace, { id: "job-after-crash", status: "queued" });

  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(fs.existsSync(lockFile), false);
  const savedState = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.deepEqual(savedState.jobs.map((job) => job.id), ["job-after-crash"]);
});
