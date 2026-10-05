import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_FILE_NAME = "state.json.lock";
// An update holds the lock for milliseconds, so a lock this old belongs to a hung process.
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_TIMEOUT_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateRoot() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  return pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
}

/**
 * Jobs recorded for every workspace except `workspaceRoot`. State is kept per workspace, so a
 * job started with --cwd, or from a worktree, is invisible from the main checkout without this.
 * Each job carries the workspaceRoot it belongs to.
 */
export function listJobsInOtherWorkspaces(workspaceRoot) {
  const ownStateDir = resolveStateDir(workspaceRoot);
  const stateRoot = resolveStateRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const jobs = [];
  for (const entry of entries) {
    const stateDir = path.join(stateRoot, entry.name);
    if (!entry.isDirectory() || stateDir === ownStateDir) {
      continue;
    }
    try {
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE_NAME), "utf8"));
      for (const job of Array.isArray(state.jobs) ? state.jobs : []) {
        if (job?.id && job.workspaceRoot) {
          jobs.push(job);
        }
      }
    } catch {
      // A missing or corrupt state file in another workspace is not this workspace's problem.
    }
  }
  return jobs;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Readers never see a half-written file: the content goes to a sibling temp file that is then
// renamed over the target. Windows can refuse the rename briefly while another process has the
// target open, so a few retries cover that.
function writeFileAtomic(filePath, content) {
  const tempFile = `${filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempFile, content, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempFile, filePath);
      return;
    } catch (error) {
      if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) {
        fs.rmSync(tempFile, { force: true });
        throw error;
      }
      sleepSync(50);
    }
  }
}

function tryCreateLock(lockFile, token) {
  try {
    fs.writeFileSync(lockFile, token, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    // Windows reports a lock file that is being deleted as EPERM rather than EEXIST.
    if (error?.code === "EEXIST" || (process.platform === "win32" && error?.code === "EPERM")) {
      return false;
    }
    throw error;
  }
}

// A lock is stale when its owner has died, or has held it far longer than any update takes.
function isLockStale(lockFile) {
  let content;
  let modifiedAt;
  try {
    modifiedAt = fs.statSync(lockFile).mtimeMs;
    content = fs.readFileSync(lockFile, "utf8");
  } catch {
    return false;
  }
  if (Date.now() - modifiedAt > STATE_LOCK_STALE_MS) {
    return true;
  }
  const pid = Number.parseInt(content, 10);
  return Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
}

// Every change to state.json is a read-modify-write, and several processes make them at once
// (each dispatch worker records its own progress). Without the lock, a writer working from an
// older read drops the jobs recorded since then and deletes their job files.
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
  const token = `${process.pid} ${randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  while (!tryCreateLock(lockFile, token)) {
    if (isLockStale(lockFile)) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the Codex job state lock ${lockFile}. If no Codex command is running, delete it.`);
    }
    sleepSync(10 + Math.random() * 20);
  }

  try {
    return fn();
  } finally {
    try {
      // A lock taken over as stale now belongs to another process; leave it alone.
      if (fs.readFileSync(lockFile, "utf8") === token) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Already removed.
    }
  }
}

// Called with the state lock held. `previousJobs` comes from the same read the new state was
// built from, so only jobs this update dropped (pruned or removed) lose their files.
function saveState(cwd, state, previousJobs) {
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  return nextState;
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const previousJobs = [...state.jobs];
    mutate(state);
    return saveState(cwd, state, previousJobs);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
