#!/usr/bin/env node

// PreToolUse guard for the codex:dispatch relay agent. The relay exists only to forward a
// payload to Codex; if its model starts doing the task itself, Claude gets a Claude answer
// dressed up as a Codex report. This hook rejects every Bash command from the relay except
// the dispatch and wait commands, so doing the work itself is not an option.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RELAY_AGENT_TYPE = "codex:dispatch";
const HEREDOC_MARKER = "CODEX_DISPATCH_PROMPT_EOF";
const COMPANION_SCRIPT = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "codex-companion.mjs");

const DISPATCH_LINE = new RegExp(`^node "([^"]+)" dispatch(?: --resume [A-Za-z0-9._-]+)? <<'${HEREDOC_MARKER}'$`);
const WAIT_COMMAND = /^node "([^"]+)" wait [A-Za-z0-9._-]+ --cwd "[^"`$\\]*"$/;

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isCompanionScript(filePath) {
  return canonicalPath(filePath) === canonicalPath(COMPANION_SCRIPT);
}

export function isAllowedRelayCommand(command) {
  const text = String(command ?? "").trim();
  const wait = text.match(WAIT_COMMAND);
  if (wait) {
    return isCompanionScript(wait[1]);
  }

  const lines = text.split(/\r?\n/);
  const dispatch = lines[0]?.match(DISPATCH_LINE);
  if (lines.length < 3 || !dispatch || !isCompanionScript(dispatch[1])) {
    return false;
  }
  // The marker must appear exactly once, as the final line. An earlier marker would end
  // the heredoc and let the remaining lines run as shell commands.
  const markerLines = lines.filter((line) => line === HEREDOC_MARKER);
  return markerLines.length === 1 && lines.at(-1) === HEREDOC_MARKER;
}

export function buildDenialReason() {
  return [
    "codex:dispatch is a relay: it may only run the Codex dispatch commands, never do the task itself.",
    "Forward the payload you received, verbatim, with:",
    "",
    `node "${COMPANION_SCRIPT}" dispatch <<'${HEREDOC_MARKER}'`,
    "<the payload, verbatim>",
    HEREDOC_MARKER,
    "",
    "For a follow-up, add `--resume <job-id>` after `dispatch`. To keep waiting, run the `NEXT:` command from the last output exactly as given."
  ].join("\n");
}

function main() {
  const raw = fs.readFileSync(0, "utf8").trim();
  const input = raw ? JSON.parse(raw) : {};
  if (input.agent_type !== RELAY_AGENT_TYPE || input.tool_name !== "Bash") {
    return;
  }
  if (isAllowedRelayCommand(input.tool_input?.command)) {
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: buildDenialReason()
      }
    })}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // Never break unrelated Bash calls because of a malformed hook payload.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}
