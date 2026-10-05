#!/usr/bin/env node

// Makes the codex:dispatch relay hand back the plugin's output verbatim. The relay is a model,
// and a model writing its own final message paraphrases: field tests showed it rewording Codex's
// report and summarizing the evidence block, which is labeled as observed by the plugin runtime.
// - PostToolUse (Bash): record the output of the relay's last dispatch or wait command.
// - PreToolUse (SubagentHandback): replace the relay's message with that recorded output.
// SubagentHandback is Claude Code's internal tool for a background agent's final message. If it
// is renamed, this hook stops matching and the relay's own message passes through unchanged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isAllowedRelayCommand } from "./dispatch-relay-guard.mjs";

const RELAY_AGENT_TYPE = "codex:dispatch";
const HANDBACK_TOOL = "SubagentHandback";

function recordDir() {
  const root = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "codex-companion");
  return path.join(root, "relay-handback");
}

function recordFile(agentId) {
  return path.join(recordDir(), `${String(agentId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
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

export function handleRelayHookEvent(input) {
  if (input.agent_type !== RELAY_AGENT_TYPE || !input.agent_id) {
    return null;
  }

  if (input.hook_event_name === "PostToolUse" && input.tool_name === "Bash") {
    if (!isAllowedRelayCommand(input.tool_input?.command)) {
      return null;
    }
    const output = bashOutput(input.tool_response);
    if (output) {
      fs.mkdirSync(recordDir(), { recursive: true });
      fs.writeFileSync(recordFile(input.agent_id), JSON.stringify({ output, recordedAt: new Date().toISOString() }));
    }
    return null;
  }

  if (input.hook_event_name === "PreToolUse" && input.tool_name === HANDBACK_TOOL) {
    const file = recordFile(input.agent_id);
    if (!fs.existsSync(file)) {
      return null;
    }
    const { output } = JSON.parse(fs.readFileSync(file, "utf8"));
    // One record per command turn: a later handback that ran no command must not reuse it.
    fs.rmSync(file, { force: true });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "codex:dispatch hands back the plugin's output verbatim.",
        updatedInput: { ...(input.tool_input ?? {}), message: output }
      }
    };
  }

  return null;
}

function main() {
  const raw = fs.readFileSync(0, "utf8").trim();
  const result = handleRelayHookEvent(raw ? JSON.parse(raw) : {});
  if (result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // Never block the relay because of a malformed payload; its own message then goes through.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}
