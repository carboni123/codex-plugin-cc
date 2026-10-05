# Changelog

## 1.1.0

- Add the `codex:dispatch` subagent, a drop-in Codex replacement for Claude subagents (general-purpose, implementers, research agents)
- Add `dispatch` and `wait` companion commands. Dispatches run as tracked background jobs and check in every ~100s with recent activity. `--resume <job-id>` continues a dispatch's thread, and stopping the waiting process cancels the Codex turn
- Wrap dispatched tasks in a delegated-worker contract so Codex returns a fixed report (Outcome, Details, Verification, Open issues)
- Append runtime evidence to every dispatch report: files changed, commands run, and verification exit codes, taken from the app-server event stream
- Export `CODEX_COMPANION_ROOT` from the `SessionStart` hook so the main Claude thread can run the companion directly

## 1.0.0

- Initial version of the Codex plugin for Claude Code
