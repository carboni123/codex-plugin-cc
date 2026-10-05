# Changelog

## 1.1.2

- Add model aliases `sol` (`gpt-6.1-sol`) and `astra` (`gpt-6-astra`)
- Accept the `max` and `ultra` reasoning efforts that current Codex models offer
- `dispatch` falls back to the `CODEX_DISPATCH_MODEL` / `CODEX_DISPATCH_EFFORT` environment variables when the prompt's directive line does not set a model or effort

## 1.1.1

- Run the `codex:dispatch` relay on `claude-sonnet-5-5` instead of Haiku, and tell it plainly that it forwards the prompt and never acts on it
- Add a PreToolUse guard that denies any Bash command from the `codex:dispatch` relay other than the dispatch and wait commands. It also rejects heredoc-escape and command-chaining tricks, so the relay cannot quietly do the task itself

## 1.1.0

- Add the `codex:dispatch` subagent, a drop-in Codex replacement for Claude subagents (general-purpose, implementers, research agents)
- Add `dispatch` and `wait` companion commands. Dispatches run as tracked background jobs and check in every ~100s with recent activity. `--resume <job-id>` continues a dispatch's thread, and stopping the waiting process cancels the Codex turn
- Wrap dispatched tasks in a delegated-worker contract so Codex returns a fixed report (Outcome, Details, Verification, Open issues)
- Append runtime evidence to every dispatch report: files changed, commands run, and verification exit codes, taken from the app-server event stream
- Export `CODEX_COMPANION_ROOT` from the `SessionStart` hook so the main Claude thread can run the companion directly

## 1.0.0

- Initial version of the Codex plugin for Claude Code
