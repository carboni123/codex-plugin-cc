import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { runCommand } from "./process.mjs";
import { resolveStateRoot } from "./state.mjs";

export const SOURCE_ENV = "CODEX_PLUGIN_SOURCE";
const DISPATCH_ENV_VARS = [
  "CODEX_DISPATCH_MODEL",
  "CODEX_DISPATCH_EFFORT",
  "CODEX_DISPATCH_NETWORK",
  "CODEX_DISPATCH_WRITABLE_ROOTS",
  "CODEX_COMPANION_BROKER_IDLE_MS",
  "CODEX_COMPANION_EVENT_LOG"
];
const LOG_TAIL_LINES = 15;

export const KNOWN_LIMITATIONS = [
  "The evidence lists commands from Codex's app-server event stream, which sends nothing for a command or edit the sandbox refused. Codex's session file (below, per job) has every call.",
  "A `?` marks a compound command (`a; b`, `a | b`, `a || b`, several lines): its exit code is only the last part's.",
  "The relay's verbatim handback intercepts Claude Code's internal SubagentHandback tool. If that tool changes, the relay's own (possibly reworded) message comes through instead; compare it with `/codex:result <job-id>`.",
  "In a read-only run with --writable-root, only the repository's changes are tracked; files written in the writable roots are not listed.",
  "CODEX_COMPANION_ROOT is exported by the SessionStart hook, so sessions started before this plugin version was installed do not have it.",
  "A Claude Code session keeps the plugin version it loaded until /reload-plugins; installing an update alone changes nothing in a running session."
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function installedPlugin() {
  const installed = readJson(path.join(claudeConfigDir(), "plugins", "installed_plugins.json"));
  const entry = Object.entries(installed?.plugins ?? {}).find(([id]) => id.startsWith("codex@"));
  if (!entry) {
    return null;
  }
  const [id, records] = entry;
  const record = Array.isArray(records) ? records[0] : records;
  return { id, marketplace: id.slice("codex@".length), version: record?.version ?? null, installPath: record?.installPath ?? null };
}

function describeSource() {
  const configured = process.env[SOURCE_ENV];
  if (!configured) {
    return null;
  }
  const sourcePath = path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(sourcePath)) {
    return { path: sourcePath, error: "does not exist" };
  }
  const git = (args) => {
    const result = runCommand("git", args, { cwd: sourcePath });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const manifest = readJson(path.join(sourcePath, "plugins", "codex", ".claude-plugin", "plugin.json"));
  return {
    path: sourcePath,
    version: manifest?.version ?? null,
    branch: git(["branch", "--show-current"]),
    head: git(["log", "--oneline", "-1"]),
    uncommitted: (git(["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length
  };
}

// Codex keeps one session file per thread under $CODEX_HOME/sessions/YYYY/MM/DD/.
export function findCodexSessionFile(threadId, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  if (!threadId) {
    return null;
  }
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        return full;
      }
      if (entry.isDirectory() && depth > 0) {
        const found = walk(full, depth - 1);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };
  return walk(path.join(codexHome, "sessions"), 3);
}

// The timestamped activity lines; the log also holds copies of messages and the final report.
function activityTail(file, lines) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => /^\[\d{4}-\d{2}-\d{2}T/.test(line))
      .slice(-lines);
  } catch {
    return [];
  }
}

export function buildTroubleshootReport({ rootDir, workspaceRoot, jobSnapshot = null, storedJob = null, recentJobs = [] }) {
  const loaded = readJson(path.join(rootDir, ".claude-plugin", "plugin.json"));
  const installed = installedPlugin();
  const codexVersion = runCommand("codex", ["--version"]);
  const handbackDir = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-companion"), "relay-handback");
  let pendingHandbacks = 0;
  try {
    pendingHandbacks = fs.readdirSync(handbackDir).length;
  } catch {
    pendingHandbacks = 0;
  }

  const report = {
    plugin: {
      loadedVersion: loaded?.version ?? null,
      loadedPath: rootDir,
      installedVersion: installed?.version ?? null,
      installedPath: installed?.installPath ?? null,
      marketplace: installed?.marketplace ?? null,
      repository: loaded?.repository ?? null,
      source: describeSource()
    },
    codex: codexVersion.status === 0 ? codexVersion.stdout.trim() : `unavailable: ${(codexVersion.stderr || codexVersion.error?.message || "").trim()}`,
    environment: Object.fromEntries(
      [...DISPATCH_ENV_VARS, "CODEX_COMPANION_ROOT", "CLAUDE_PLUGIN_DATA"].map((name) => [name, process.env[name] ?? null])
    ),
    workspaceRoot,
    stateRoot: resolveStateRoot(),
    broker: loadBrokerSession(workspaceRoot),
    pendingHandbacks,
    recentJobs,
    job: null,
    knownLimitations: KNOWN_LIMITATIONS
  };

  if (jobSnapshot) {
    const job = jobSnapshot.job;
    const request = storedJob?.request ?? {};
    report.job = {
      id: job.id,
      kind: job.kindLabel,
      status: job.status,
      phase: job.phase ?? null,
      elapsed: job.elapsed ?? job.duration ?? null,
      workspaceRoot: jobSnapshot.workspaceRoot,
      error: job.errorMessage ?? storedJob?.errorMessage ?? null,
      threadId: storedJob?.threadId ?? job.threadId ?? null,
      resumedFrom: storedJob?.resumedFrom ?? request.resumedFrom ?? null,
      settings: {
        cwd: request.cwd ?? null,
        write: request.write ?? null,
        network: request.network ?? null,
        writableRoots: request.writableRoots ?? [],
        worktree: request.worktree ?? null,
        model: request.model ?? null,
        effort: request.effort ?? null,
        raw: request.raw ?? null,
        sandboxPolicy: request.sandbox?.policy ?? null
      },
      logFile: job.logFile ?? null,
      logTail: job.logFile ? activityTail(job.logFile, LOG_TAIL_LINES) : [],
      codexSessionFile: findCodexSessionFile(storedJob?.threadId ?? job.threadId),
      rendered: storedJob?.rendered ?? null
    };
  }
  return report;
}

function value(text) {
  return text == null || text === "" ? "(not set)" : String(text);
}

export function renderTroubleshootReport(report) {
  const { plugin } = report;
  const lines = ["# Codex plugin troubleshooting", "", "## Plugin"];
  lines.push(`- Loaded in this session: ${value(plugin.loadedVersion)} (${plugin.loadedPath})`);
  lines.push(`- Installed: ${value(plugin.installedVersion)} (${value(plugin.installedPath)}), marketplace ${value(plugin.marketplace)}`);
  if (plugin.loadedVersion && plugin.installedVersion && plugin.loadedVersion !== plugin.installedVersion) {
    lines.push("- **This session runs an older version than the one installed. Run /reload-plugins.**");
  }
  lines.push(`- Codex CLI: ${report.codex}`);
  lines.push("", "## Where the plugin comes from");
  lines.push(`- Repository: ${value(plugin.repository)}`);
  if (plugin.source?.error) {
    lines.push(`- Local source (${SOURCE_ENV}): ${plugin.source.path} ${plugin.source.error}`);
  } else if (plugin.source) {
    lines.push(
      `- Local source (${SOURCE_ENV}): ${plugin.source.path} · version ${value(plugin.source.version)} · branch ${value(plugin.source.branch)} · ${value(plugin.source.head)} · ${plugin.source.uncommitted} uncommitted change(s)`
    );
  } else {
    lines.push(`- Local source: not configured (set ${SOURCE_ENV} to the plugin checkout to have troubleshooting sessions fix it there)`);
  }
  lines.push(
    `- The installed copy is a cache that updates overwrite: change the source instead, run its tests (\`npm test\`), bump the version, push, then \`claude plugin marketplace update ${plugin.marketplace ?? "<marketplace>"} && claude plugin update ${plugin.marketplace ? `codex@${plugin.marketplace}` : "codex@<marketplace>"}\` and /reload-plugins.`
  );

  lines.push("", "## Environment");
  for (const [name, setting] of Object.entries(report.environment)) {
    lines.push(`- ${name}: ${value(setting)}`);
  }
  lines.push(`- Workspace: ${report.workspaceRoot}`);
  lines.push(`- Job state root: ${report.stateRoot}`);
  lines.push(`- Shared broker for this workspace: ${report.broker ? `${report.broker.endpoint} (pid ${report.broker.pid ?? "?"})` : "none"}`);
  if (report.pendingHandbacks > 0) {
    lines.push(`- Unconsumed relay handback records: ${report.pendingHandbacks} (a relay recorded output but never handed back, e.g. it was stopped)`);
  }

  if (report.job) {
    const { job } = report;
    lines.push("", `## Job ${job.id}`);
    lines.push(`- ${job.kind} · ${job.status}${job.phase ? ` (${job.phase})` : ""}${job.elapsed ? ` · ${job.elapsed}` : ""}`);
    lines.push(`- Workspace: ${job.workspaceRoot}`);
    if (job.resumedFrom) {
      lines.push(`- Follow-up to: ${job.resumedFrom}`);
    }
    if (job.error) {
      lines.push(`- Error: ${job.error}`);
    }
    lines.push(`- Codex thread: ${value(job.threadId)}`);
    lines.push(`- Codex session file (every call, including sandbox-refused ones): ${value(job.codexSessionFile)}`);
    lines.push(`- Settings: ${JSON.stringify(job.settings)}`);
    lines.push(`- Log: ${value(job.logFile)}`);
    if (job.logTail.length) {
      lines.push("", "```text", ...job.logTail, "```");
    }
    if (job.rendered) {
      lines.push("", "Stored report (what the plugin returned):", "", "```text", job.rendered.trimEnd(), "```");
    }
  } else {
    lines.push("", "## Recent jobs");
    if (report.recentJobs.length === 0) {
      lines.push("- none in this workspace or session");
    }
    for (const job of report.recentJobs) {
      lines.push(`- ${job.id} · ${job.kindLabel} · ${job.status}${job.summary ? ` · ${job.summary}` : ""}`);
    }
    lines.push("", "Run `/codex:troubleshoot <job-id>` for a job's settings, log, Codex session file, and stored report.");
  }

  lines.push("", "## Known limitations");
  for (const limitation of report.knownLimitations) {
    lines.push(`- ${limitation}`);
  }
  return `${lines.join("\n")}\n`;
}
