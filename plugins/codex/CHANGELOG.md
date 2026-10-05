# Changelog

## 1.5.0

- `/codex:troubleshoot [job-id]`, a command Claude can also run on its own. It shows the plugin version this session loaded vs the one installed (flagging when `/reload-plugins` is needed), the Codex CLI version, where the plugin source lives (repository, plus a local checkout through `CODEX_PLUGIN_SOURCE`) and how to ship a fix, the dispatch settings and state paths, and the known limitations. For a job it adds the settings, workspace, follow-up chain, recent activity log, Codex session file, and stored report
- Failed and cancelled dispatch reports end with `Diagnose: /codex:troubleshoot <job-id>`; the dispatch agent description points to the command
- `plugin.json` names the repository

## 1.4.0

- The `codex:dispatch` relay now hands back the plugin's output verbatim. A live test showed the Sonnet relay rewording Codex's report and summarizing the evidence block, although its instructions say to return the output unchanged. A PostToolUse hook records the output of the relay's last dispatch or wait command, and a PreToolUse hook on Claude Code's internal `SubagentHandback` tool replaces the relay's final message with it. Each record is used once. If the internal tool changes, the hook stops matching and the relay's own message passes through

## 1.3.2

Fixes from an end-to-end test through the relay:

- A follow-up now runs in the directory of the run it resumes, and reads that run's settings from that run's workspace. Before, a follow-up without `--cwd` used the relay shell's directory: it ran write-capable in whatever repository the Claude session was in, and silently lost the original sandbox, network, model, and effort
- Cancelling a dispatch no longer asks another app-server to interrupt its turn. That always failed ("thread not found") and could start an app-server just to fail; killing the worker's process group already ends the turn
- Unwrapping `bash -c "…"` undoes its quoting, so `python3 -c "a; b"` is no longer flagged as a compound command and escaped characters display normally

## 1.3.1

- Evidence marks compound commands (`a; b`, `a | b`, `a || b`, multi-line scripts) with `?` and "exit N from the last command only" instead of `✓`. The shell reports only the last part's exit code, so `pnpm test | tail` or `touch x; echo exit=$?` looked successful even when an earlier part failed. `&&` chains and here-documents are not flagged

## 1.3.0

- `--worktree` dispatch directive: Codex works in its own git worktree, on a new `codex-dispatch/<job>` branch from the current commit, kept in the plugin's state directory. The report gives the path, branch, and commands to keep (commit and merge) or discard the changes; an unchanged worktree and its branch are removed. Follow-ups continue in the same worktree, and evidence is taken from the worktree
- Jobs are found across workspaces: `/codex:status <id>`, `/codex:result <id>`, `/codex:cancel <id>`, `wait <id>`, and `dispatch --resume <id>` fall back to every workspace's state when the id is not local. `/codex:status` lists this session's jobs from other workspaces, marked with their workspace
- Cancelling sends the turn interrupt through the job's own workspace, not the caller's
- `/codex:result <id>` on a running job now says it is still running instead of "No job found"
- Cross-workspace lookup and plugin-managed worktrees adapted from github.com/dragon84867/codex-plugin-cc

## 1.2.1

- Brokers shut down after 5 minutes without a client (`CODEX_COMPANION_BROKER_IDLE_MS`). Before, a broker for any workspace other than the session's own (`--cwd` runs, worktrees, test repositories) lived until reboot
- A broker that exits on its own removes its session directory and its `broker.json` entry
- A stale broker that stopped answering is killed instead of orphaned, but only after `ps` confirms the pid still belongs to a broker, since a dead broker's pid may have been reused
- `npm test` is hermetic: each test process uses one throwaway root for temp repositories, plugin state, and brokers, deleted on exit, and ignores the session variables Claude Code exports. Before, every run left hundreds of directories in `/tmp`, and running inside a Claude Code session broke tests
- Idle timeout and stale-broker kill adapted from github.com/dragon84867/codex-plugin-cc

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
