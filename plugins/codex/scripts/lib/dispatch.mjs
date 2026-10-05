import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";

// Stays under Claude Code's default 2-minute Bash timeout, so a forwarding agent that
// forgets to raise its Bash timeout still gets a clean "still running" checkpoint.
export const DEFAULT_DISPATCH_TIMEOUT_MS = 100_000;
export const DISPATCH_THREAD_PREFIX = "Codex Dispatch";

// --timeout is deliberately not a directive: it only works when the caller also controls its
// Bash timeout, and a relay killed mid-wait cancels the Codex turn.
export const DISPATCH_DIRECTIVE_OPTIONS = {
  valueOptions: ["model", "effort", "cwd", "label", "resume", "prompt-file"],
  booleanOptions: ["read-only", "write", "raw", "network", "no-network"],
  arrayOptions: ["writable-root"]
};

const NETWORK_ENV = "CODEX_DISPATCH_NETWORK";
const WRITABLE_ROOTS_ENV = "CODEX_DISPATCH_WRITABLE_ROOTS";

// Codex's shell tool runs `bash -lc` by default. On distributions whose /etc/profile rebuilds
// PATH (Debian, Ubuntu), that drops tools installed through version managers like nvm, which
// only load in ~/.bashrc. A non-login shell keeps the PATH Claude Code's own Bash tool has.
export const DISPATCH_THREAD_CONFIG = { allow_login_shell: false };

function parseSwitch(value, name) {
  const text = String(value).trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(text)) {
    return true;
  }
  if (["off", "false", "0", "no"].includes(text)) {
    return false;
  }
  throw new Error(`Invalid ${name} value "${value}". Use on or off.`);
}

/**
 * Write runs get network access by default, like a Claude subagent: tests that use a local
 * database, a fake server on a loopback port, or Docker need it. Read-only runs stay offline
 * by default, because network access also reaches local services and the Docker socket,
 * through which a "read-only" run could still change state.
 * Precedence: directive, then CODEX_DISPATCH_NETWORK, then the sandbox default.
 */
export function resolveDispatchNetwork(options, write, env = process.env) {
  if (options.network && options["no-network"]) {
    throw new Error("Choose either --network or --no-network.");
  }
  if (options.network) {
    return true;
  }
  if (options["no-network"]) {
    return false;
  }
  if (env[NETWORK_ENV]) {
    return parseSwitch(env[NETWORK_ENV], NETWORK_ENV);
  }
  return write;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveDispatchWritableRoots(options, cwd, env = process.env) {
  const raw = options["writable-root"] ?? (env[WRITABLE_ROOTS_ENV] ? env[WRITABLE_ROOTS_ENV].split(path.delimiter) : []);
  return raw
    .filter((root) => root && root.trim())
    .map((root) => {
      const resolved = path.resolve(cwd, root.trim());
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`Writable root ${resolved} is not an existing directory.`);
      }
      return fs.realpathSync.native(resolved);
    });
}

/**
 * Decides where Codex runs and what it may write.
 * - write: the repository, /tmp, and any extra writable roots.
 * - read-only: nothing.
 * - read-only with writable roots (a reviewer setup): the repository stays read-only and the
 *   writable roots do not. A workspace-write sandbox always makes the app-server's working
 *   directory writable, so Codex runs from the first writable root and reads the repository
 *   by absolute path.
 */
export function resolveDispatchSandbox({ write, network, writableRoots = [], workspaceRoot }) {
  const workspaceWrite = (roots, excludeTmp) => ({
    type: "workspaceWrite",
    writableRoots: roots,
    networkAccess: network,
    excludeTmpdirEnvVar: excludeTmp,
    excludeSlashTmp: excludeTmp
  });
  if (write) {
    return { mode: "write", serverCwd: workspaceRoot, writableRoots, policy: workspaceWrite(writableRoots, false) };
  }
  if (writableRoots.length === 0) {
    return { mode: "read-only", serverCwd: workspaceRoot, writableRoots, policy: { type: "readOnly", networkAccess: network } };
  }

  const repository = fs.realpathSync.native(workspaceRoot);
  const covering = writableRoots.find((root) => isInside(repository, root));
  if (covering) {
    throw new Error(`Writable root ${covering} contains the repository, so the run could not stay read-only.`);
  }
  // /tmp is writable in a workspace-write sandbox unless excluded; keep it out when the
  // repository itself lives there.
  const repositoryInTmp = [os.tmpdir(), "/tmp"].some((tmp) => isInside(repository, fs.existsSync(tmp) ? fs.realpathSync.native(tmp) : tmp));
  const [scratch, ...others] = writableRoots;
  return { mode: "read-only-with-scratch", serverCwd: scratch, writableRoots, policy: workspaceWrite(others, repositoryInTmp) };
}

export function describeSandbox(sandbox) {
  if (sandbox.mode === "write") {
    return sandbox.writableRoots.length ? `workspace-write + ${sandbox.writableRoots.join(", ")}` : "workspace-write";
  }
  if (sandbox.mode === "read-only") {
    return "read-only";
  }
  return `read-only repository, writable: ${sandbox.writableRoots.join(", ")}`;
}

const MAX_LISTED_FILES = 20;
const LIST_ALL_COMMANDS_UP_TO = 10;
const RECENT_COMMANDS = 5;
const MAX_VERIFICATION_COMMANDS = 6;

const WRITE_SANDBOX_RULES =
  "- You may edit files in the workspace to complete the task. Keep edits minimal and consistent with the surrounding code.";
const READ_ONLY_SANDBOX_RULES =
  "- This run is read-only: the sandbox blocks file edits. Investigate and report; describe the changes you would make instead of attempting them.";

function sandboxRules(sandbox, workspaceRoot) {
  if (sandbox.mode === "write") {
    return sandbox.writableRoots.length
      ? `${WRITE_SANDBOX_RULES}\n- You may also write in: ${sandbox.writableRoots.join(", ")}.`
      : WRITE_SANDBOX_RULES;
  }
  if (sandbox.mode === "read-only") {
    return READ_ONLY_SANDBOX_RULES;
  }
  return [
    `- The repository at ${workspaceRoot} is read-only for this run; read it by absolute path, starting with its AGENTS.md if it has one.`,
    `- You may write only in ${sandbox.writableRoots.join(", ")}. Your working directory is ${sandbox.serverCwd}.`
  ].join("\n");
}
const NETWORK_ON_RULES = "- Network access is on: loopback ports, local services, Docker, and the internet are reachable.";
const NETWORK_OFF_RULES =
  "- Network access is off: loopback ports, local services, Docker, and the internet are unreachable. If the task needs them, say so under Open issues instead of working around it.";

function shorten(text, limit) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

/**
 * A dispatch prompt may start with one line of flags, e.g. `--read-only --effort high`.
 * This lets the orchestrator pick runtime options through the Agent tool, whose only
 * input is the prompt text.
 */
export function splitDispatchDirectives(prompt) {
  const text = String(prompt ?? "");
  const match = text.match(/^\s*(--[^\r\n]*)(?:\r?\n|$)/);
  if (!match) {
    return { options: {}, prompt: text };
  }

  const { options, positionals } = parseArgs(splitRawArgumentString(match[1].trim()), DISPATCH_DIRECTIVE_OPTIONS);
  if (positionals.length > 0) {
    throw new Error(
      `Unsupported dispatch directive: ${positionals.join(" ")}. The first prompt line only accepts ` +
        "--read-only, --write, --network, --no-network, --writable-root, --prompt-file, --raw, --model, --effort, --cwd, --label, and --resume."
    );
  }
  return { options, prompt: text.slice(match[0].length) };
}

export function parseDuration(value, fallbackMs) {
  if (value == null || value === "" || value === true) {
    return fallbackMs;
  }
  const text = String(value).trim().toLowerCase();
  if (["none", "forever", "inf", "infinity"].includes(text)) {
    return Infinity;
  }
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use values like 90s, 5m, 0, or none.`);
  }
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(Number(match[1]) * multipliers[match[2] ?? "s"]);
}

export function buildDispatchPrompt(rootDir, { task, sandbox, network, workspaceRoot, followUp = false }) {
  const template = loadPromptTemplate(rootDir, followUp ? "dispatch-follow-up" : "dispatch");
  return interpolateTemplate(template, {
    TASK: String(task ?? "").trim(),
    SANDBOX_RULES: [sandboxRules(sandbox, workspaceRoot), network ? NETWORK_ON_RULES : NETWORK_OFF_RULES].join("\n")
  });
}

export function buildDispatchThreadName(label, task) {
  const excerpt = shorten(label || task, 56);
  return excerpt ? `${DISPATCH_THREAD_PREFIX}: ${excerpt}` : DISPATCH_THREAD_PREFIX;
}

function describeChangeKind(kind) {
  switch (kind?.type) {
    case "add":
      return "added";
    case "delete":
      return "deleted";
    case "update":
      return kind.move_path ? `moved to ${kind.move_path}` : "modified";
    default:
      return "changed";
  }
}

function displayPath(filePath, cwd) {
  if (!cwd || !path.isAbsolute(filePath)) {
    return filePath;
  }
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

export function summarizeFileChanges(fileChanges = [], cwd = null) {
  const byPath = new Map();
  for (const item of fileChanges) {
    if (item?.status && item.status !== "completed") {
      continue;
    }
    for (const change of item?.changes ?? []) {
      if (!change?.path) {
        continue;
      }
      const filePath = displayPath(change.path, cwd);
      const described = describeChangeKind(change.kind);
      // A file Codex created during the run is still "added" after later edits.
      if (byPath.get(filePath) === "added" && described === "modified") {
        continue;
      }
      byPath.set(filePath, described);
    }
  }
  return [...byPath].map(([path, change]) => ({ path, change }));
}

// Codex runs commands through a login shell; show the command Codex actually meant.
function unwrapShellCommand(command) {
  const match = String(command ?? "").match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:(['"])([\s\S]*)\1|(\S+))$/);
  return match ? match[2] ?? match[3] : String(command ?? "");
}

export function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff|mypy)\b/i.test(
    command
  );
}

export function summarizeCommands(commandExecutions = []) {
  return commandExecutions.map((item) => {
    const command = unwrapShellCommand(item?.command);
    const exitCode = typeof item?.exitCode === "number" ? item.exitCode : null;
    return {
      command,
      exitCode,
      status: item?.status ?? null,
      durationMs: typeof item?.durationMs === "number" ? item.durationMs : null,
      verification: looksLikeVerificationCommand(command),
      failed: (exitCode != null && exitCode !== 0) || item?.status === "failed" || item?.status === "declined"
    };
  });
}

function formatCommand(entry) {
  const mark = entry.failed ? "✗" : "✓";
  const outcome = entry.exitCode != null ? `exit ${entry.exitCode}` : entry.status ?? "unknown";
  const oneLine = entry.command.trim().split(/\s*\r?\n\s*/).join("; ");
  return `${mark} ${shorten(oneLine, 100)} (${outcome})`;
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function pushEvidenceLines(lines, { files = [], commands = [], write }) {
  if (files.length === 0) {
    lines.push(write ? "Files changed during the run: none" : "Files changed during the run: none (read-only run)");
  } else {
    lines.push(`Files changed during the run (${files.length}):`);
    for (const file of files.slice(0, MAX_LISTED_FILES)) {
      lines.push(`  ${file.change}: ${file.path}`);
    }
    if (files.length > MAX_LISTED_FILES) {
      lines.push(`  ... and ${files.length - MAX_LISTED_FILES} more`);
    }
  }

  const failed = commands.filter((entry) => entry.failed);
  // Verified against Codex's session log: the app-server sends no event for a command or an
  // edit the sandbox refuses, so this list can be short. Say so instead of implying it is complete.
  const caveat = "commands and edits the sandbox refused are not reported";
  if (commands.length === 0) {
    lines.push(`Commands reported: none (${caveat})`);
    return;
  }
  lines.push(
    `Commands reported: ${commands.length}${failed.length ? `, ${failed.length} with non-zero exit` : ""} (${caveat})`
  );

  const shown = selectCommandsToShow(commands);
  if (shown.length < commands.length) {
    lines.push(`  (showing ${shown.length}: the last run of each test/build/lint command and the last ${RECENT_COMMANDS} commands)`);
  }
  for (const index of shown) {
    lines.push(`  ${formatCommand(commands[index])}`);
  }
}

// Short runs list every command. Long runs keep what matters for checking Codex's claims:
// the final state of each verification command, plus how the run ended.
function selectCommandsToShow(commands) {
  if (commands.length <= LIST_ALL_COMMANDS_UP_TO) {
    return commands.map((_, index) => index);
  }
  const lastVerificationRun = new Map();
  commands.forEach((entry, index) => {
    if (entry.verification) {
      lastVerificationRun.delete(entry.command);
      lastVerificationRun.set(entry.command, index);
    }
  });
  const selected = new Set([...lastVerificationRun.values()].slice(-MAX_VERIFICATION_COMMANDS));
  for (let index = commands.length - RECENT_COMMANDS; index < commands.length; index += 1) {
    selected.add(index);
  }
  return [...selected].sort((left, right) => left - right);
}

/**
 * The report a dispatch returns to Claude: Codex's own final message, followed by
 * evidence the plugin observed from the app-server event stream. The evidence block
 * lets Claude check Codex's claims instead of taking the summary on trust.
 */
export function renderDispatchReport(report) {
  const lines = [];
  const finalMessage = String(report.finalMessage ?? "").trim();
  if (finalMessage) {
    lines.push(finalMessage);
  } else {
    lines.push(`Codex did not return a final message.${report.error ? ` Error: ${report.error}` : ""}`);
  }

  lines.push("", "---", "Codex dispatch evidence (observed by the plugin runtime, not written by Codex):");
  const facts = [`Status: ${report.status}`];
  const duration = formatDurationMs(report.durationMs);
  if (duration) {
    facts.push(duration);
  }
  facts.push(`job ${report.jobId}`);
  if (report.threadId) {
    facts.push(`thread ${report.threadId}`);
  }
  lines.push(facts.join(" · "));
  const network = report.network == null ? "" : ` · network ${report.network ? "on" : "off"}`;
  const sandbox = report.sandbox ?? (report.write ? "workspace-write" : "read-only");
  lines.push(`Sandbox: ${sandbox}${network} · cwd: ${report.cwd}`);
  if (report.status !== "completed" && report.error) {
    lines.push(`Error: ${shorten(report.error, 400)}`);
  }
  pushEvidenceLines(lines, report);
  if (report.threadId) {
    lines.push(`Follow up: send a message to this agent, or dispatch with --resume ${report.jobId}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderDispatchPending(job, nextCommand) {
  const details = [job.elapsed && `${job.elapsed} elapsed`, job.phase && `phase: ${job.phase}`].filter(Boolean);
  const lines = [`Codex dispatch ${job.id} is still ${job.status}${details.length ? ` (${details.join(", ")})` : ""}.`];
  if (job.progressPreview?.length) {
    lines.push("Recent activity:");
    for (const line of job.progressPreview) {
      lines.push(`  - ${line}`);
    }
  }
  lines.push(`NEXT: ${nextCommand}`);
  return `${lines.join("\n")}\n`;
}

export function renderDispatchUnfinished(job, storedJob) {
  const lines = [];
  if (job.status === "cancelled") {
    lines.push(`Codex dispatch ${job.id} was cancelled before Codex finished.`);
  } else {
    lines.push(`Codex dispatch ${job.id} failed before Codex returned a result.`);
  }
  const error = job.errorMessage ?? storedJob?.errorMessage;
  if (error) {
    lines.push(`Error: ${error}`);
  }
  if (job.progressPreview?.length) {
    lines.push("Last activity:");
    for (const line of job.progressPreview) {
      lines.push(`  - ${line}`);
    }
  }
  if (job.logFile) {
    lines.push(`Log: ${job.logFile}`);
  }
  return `${lines.join("\n")}\n`;
}
