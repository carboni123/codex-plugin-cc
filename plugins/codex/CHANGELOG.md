# Changelog

## 1.2.0

- Network access for dispatches, set per turn through the sandbox policy: on by default for write runs (loopback services, fake servers, Docker), off for read-only runs. Override with `--network` / `--no-network` or `CODEX_DISPATCH_NETWORK`
- Dispatched runs use a non-login shell, so Codex's commands keep Claude Code's `PATH`. Codex's login shell re-reads `/etc/profile`, which on Debian and Ubuntu drops nvm-installed tools such as `npx` and `pnpm`
- `--writable-root <dir>` (repeatable, or `CODEX_DISPATCH_WRITABLE_ROOTS`). On a read-only run it creates a reviewer setup: the repository stays read-only and Codex runs from the scratch directory
- `--prompt-file <path>` as a directive, so the relay forwards one line instead of retyping long assignments
- Fix: a follow-up dispatch keeps the sandbox, network, writable roots, model, effort, and `--raw` of the run it continues. Before, a follow-up to a read-only dispatch resumed write-capable
- Evidence: changed files now come from a git working-tree diff merged with patch events, which catches shell-written files. The command list states that sandbox-refused actions are not reported (the app-server emits no event for them)
- `--timeout` is no longer a directive: a value above the relay's Bash timeout got the relay killed, which cancelled the Codex turn
- The agent description documents every directive, including `--raw` and `--cwd`. `CODEX_COMPANION_EVENT_LOG=<file>` records raw app-server events for debugging

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
