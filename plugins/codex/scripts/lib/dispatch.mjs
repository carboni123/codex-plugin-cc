import path from "node:path";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";

// Stays under Claude Code's default 2-minute Bash timeout, so a forwarding agent that
// forgets to raise its Bash timeout still gets a clean "still running" checkpoint.
export const DEFAULT_DISPATCH_TIMEOUT_MS = 100_000;
export const DISPATCH_THREAD_PREFIX = "Codex Dispatch";

export const DISPATCH_DIRECTIVE_OPTIONS = {
  valueOptions: ["model", "effort", "cwd", "label", "resume", "timeout"],
  booleanOptions: ["read-only", "write", "raw"]
};

const MAX_LISTED_FILES = 20;
const LIST_ALL_COMMANDS_UP_TO = 10;
const RECENT_COMMANDS = 5;
const MAX_VERIFICATION_COMMANDS = 6;

const WRITE_SANDBOX_RULES =
  "- You may edit files in the workspace to complete the task. Keep edits minimal and consistent with the surrounding code.";
const READ_ONLY_SANDBOX_RULES =
  "- This run is read-only: the sandbox blocks file edits. Investigate and report; describe the changes you would make instead of attempting them.";

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
        "--read-only, --write, --raw, --model, --effort, --cwd, --label, --resume, and --timeout."
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

export function buildDispatchPrompt(rootDir, { task, write, followUp = false }) {
  const template = loadPromptTemplate(rootDir, followUp ? "dispatch-follow-up" : "dispatch");
  return interpolateTemplate(template, {
    TASK: String(task ?? "").trim(),
    SANDBOX_RULES: write ? WRITE_SANDBOX_RULES : READ_ONLY_SANDBOX_RULES
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
  const match = String(command ?? "").match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return match ? match[2] : String(command ?? "");
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
  return `${mark} ${shorten(entry.command, 100)} (${outcome})`;
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
    lines.push(write ? "Files changed: none" : "Files changed: none (read-only run)");
  } else {
    lines.push(`Files changed (${files.length}):`);
    for (const file of files.slice(0, MAX_LISTED_FILES)) {
      lines.push(`  ${file.change}: ${file.path}`);
    }
    if (files.length > MAX_LISTED_FILES) {
      lines.push(`  ... and ${files.length - MAX_LISTED_FILES} more`);
    }
  }

  const failed = commands.filter((entry) => entry.failed);
  if (commands.length === 0) {
    lines.push("Commands run: none");
    return;
  }
  lines.push(`Commands run: ${commands.length}${failed.length ? ` (${failed.length} with non-zero exit)` : ""}`);

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
  lines.push(`Sandbox: ${report.write ? "workspace-write" : "read-only"} · cwd: ${report.cwd}`);
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
