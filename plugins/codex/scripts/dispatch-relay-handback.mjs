#!/usr/bin/env node

// Delivers a codex:dispatch report to the conversation that receives the relay agent's result,
// exactly as the plugin stored it. The relay is a model, and a model that retypes a report
// rewrites it: it shortens Codex's message, turns the evidence block into prose, and completes
// commands the plugin had truncated. So the relay runs the companion with --relay, which prints
// a two-line handoff instead of the report, and these hooks attach the report itself:
// - PostToolUse (Bash), in the relay: note the job its last dispatch or wait command finished.
// - UserPromptSubmit, in the caller: a background relay reports back through a task
//   notification, and the report is added to that notification as context.
// - PostToolUse (Agent), in the caller: a foreground relay's result is replaced by the report.
// - PreToolUse (SubagentHandback), in the relay: in auto mode a subagent delivers its result
//   through this tool, and its message is replaced by the report.
// When none of them fires, the caller still has the handoff, which says how to get the report.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isAllowedRelayCommand } from "./dispatch-relay-guard.mjs";
import { parseDispatchHandoff } from "./lib/dispatch-handoff.mjs";

const RELAY_AGENT_TYPE = "codex:dispatch";
const HANDBACK_TOOL = "SubagentHandback";
// A record is used within seconds of being written. One this old belongs to a relay whose
// caller never received its result, for example because the session ended first.
const RECORD_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Claude Code moves hook context longer than this to a file and shows the model its first
// 2,000 characters.
const INLINE_CONTEXT_LIMIT = 10_000;

function recordDir() {
  const root = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-companion");
  return path.join(root, "relay-handback");
}

function recordFile(agentId) {
  return path.join(recordDir(), `${String(agentId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function pruneOldRecords() {
  const cutoff = Date.now() - RECORD_MAX_AGE_MS;
  for (const name of fs.readdirSync(recordDir())) {
    const file = path.join(recordDir(), name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Another hook process removed it first.
    }
  }
}

function writeRecord(agentId, jobId) {
  fs.mkdirSync(recordDir(), { recursive: true });
  fs.writeFileSync(recordFile(agentId), JSON.stringify({ jobId, recordedAt: new Date().toISOString() }));
  pruneOldRecords();
}

// A record is used once: a later result from the same relay that finished no job must not be
// given this job's report.
function takeRecord(agentId) {
  const file = recordFile(agentId);
  if (!agentId || !fs.existsSync(file)) {
    return null;
  }
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.rmSync(file, { force: true });
  return typeof record.jobId === "string" ? record.jobId : null;
}

async function takeReport(agentId, cwd) {
  const jobId = takeRecord(agentId);
  if (!jobId) {
    return null;
  }
  // Loaded only here, so the hook stays cheap on the prompts and tool calls it has nothing to add to.
  const { readDispatchReport } = await import("./lib/dispatch-report.mjs");
  const found = readDispatchReport(cwd || process.cwd(), jobId);
  return found ? { jobId, report: found.report.trimEnd() } : null;
}

// The Bash tool's result as the relay saw it: stdout, then stderr.
export function bashOutput(toolResponse) {
  if (typeof toolResponse === "string") {
    return toolResponse;
  }
  if (!toolResponse || typeof toolResponse !== "object") {
    return "";
  }
  const stdout = toolResponse.stdout ?? toolResponse.output ?? "";
  const stderr = toolResponse.stderr ?? "";
  return [String(stdout).trimEnd(), String(stderr).trimEnd()].filter(Boolean).join("\n");
}

function recordRelayCommand(input) {
  if (!isAllowedRelayCommand(input.tool_input?.command)) {
    return;
  }
  const handoff = parseDispatchHandoff(bashOutput(input.tool_response));
  if (handoff) {
    writeRecord(input.agent_id, handoff.jobId);
  } else {
    // Still waiting, or a new dispatch: an earlier job's record no longer describes this relay's result.
    fs.rmSync(recordFile(input.agent_id), { force: true });
  }
}

function describeReport({ jobId, report }) {
  const header = `Codex dispatch report for job ${jobId}, exactly as the Codex plugin stored it. The relay agent's own message only names the job.`;
  const context = `${header}\n\n${report}`;
  if (context.length <= INLINE_CONTEXT_LIMIT) {
    return context;
  }
  return `${header} The report is ${report.length} characters long, more than hook context carries inline, so only its beginning is shown here. The rest, including the runtime evidence at its end, is in the file this reminder names; /codex:result ${jobId} prints it too.\n\n${report}`;
}

async function attachToNotification(input) {
  const prompt = String(input.prompt ?? "");
  if (!prompt.includes("<task-notification>")) {
    return null;
  }
  const reports = [];
  for (const [, agentId] of prompt.matchAll(/<task-id>([^<\s]+)<\/task-id>/g)) {
    const found = await takeReport(agentId, input.cwd);
    if (found) {
      reports.push(describeReport(found));
    }
  }
  if (reports.length === 0) {
    return null;
  }
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: reports.join("\n\n") } };
}

async function replaceAgentResult(input) {
  const response = input.tool_response;
  const agentType = response?.agentType ?? input.tool_input?.subagent_type;
  if (agentType !== RELAY_AGENT_TYPE || response?.status !== "completed") {
    return null;
  }
  const found = await takeReport(response.agentId, input.cwd);
  if (!found) {
    return null;
  }
  // A replacement has to keep the Agent tool's output shape, or Claude Code ignores it.
  if (Array.isArray(response.content)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: { ...response, content: [{ type: "text", text: found.report }] }
      }
    };
  }
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: describeReport(found) } };
}

async function replaceHandback(input) {
  const found = await takeReport(input.agent_id, input.cwd);
  if (!found) {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "codex:dispatch delivers the report the Codex plugin stored.",
      updatedInput: { ...(input.tool_input ?? {}), message: found.report }
    }
  };
}

export async function handleRelayHookEvent(input) {
  const inRelay = input.agent_type === RELAY_AGENT_TYPE && Boolean(input.agent_id);

  if (input.hook_event_name === "UserPromptSubmit") {
    return attachToNotification(input);
  }
  if (input.hook_event_name === "PostToolUse" && input.tool_name === "Agent") {
    return replaceAgentResult(input);
  }
  if (input.hook_event_name === "PostToolUse" && input.tool_name === "Bash" && inRelay) {
    recordRelayCommand(input);
    return null;
  }
  if (input.hook_event_name === "PreToolUse" && input.tool_name === HANDBACK_TOOL && inRelay) {
    return replaceHandback(input);
  }
  return null;
}

async function main() {
  const raw = fs.readFileSync(0, "utf8").trim();
  const result = await handleRelayHookEvent(raw ? JSON.parse(raw) : {});
  if (result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never block a prompt or a tool call because of a malformed payload: the handoff the relay
    // returned still says how to get the report.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  });
}
