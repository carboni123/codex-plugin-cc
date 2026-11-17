# Changelog

## 1.8.0

- `sol` and `astra` run the newest model of their family that Codex lists for the account, read from the app server's `model/list` when a command uses the name. Until now each stood for a fixed id (`gpt-6.1-sol`, `gpt-6-astra`), so a new release needed a plugin update. With `CODEX_DISPATCH_MODEL=sol` the dispatch default follows new releases too; a model id there pins it. When the list cannot be read or has no model of the family, the built-in id is used, now `gpt-6.2-sol` and `gpt-6.2-astra`
- A follow-up that names no model stays on the model id its thread started with
- The evidence block names the model and effort the run used ("Model: gpt-6.2-sol · effort high"), as Codex reported them for the thread. `--json` output has `model` and `effort`
- `/codex:troubleshoot` lists which model each family name stands for right now, and why when it is the built-in id. A job's settings say when its model came from a family name
- `review --model` and `adversarial-review --model` accept the same names; they had passed `sol` to Codex as a model id

## 1.7.2

- A `?` in the evidence now means something. Until now every line with `;`, `|`, `||`, or a line break got one, which was 17,059 of about 35,500 recorded commands that exited 0, most of them bundles of file reads (`sed -n …; rg …; cat …`). The mark is kept for the two cases where the exit code leaves out a part that matters, 2,436 of those commands: a test, build, or lint run whose result the line hides, now named ("exit 0, but not from `pnpm test`"), and any other hidden command that does more than read files
- Lines whose unchecked parts only read files get `✓`. Lines whose unchecked parts only set up the shell (`set -a; . ./.env; set +a; pnpm test`) get `✓` and "exit 0 from the last command"
- The exit code is recognized as covering the line for `set -e` scripts (`set -o pipefail` for pipes), `( … )` and `{ …; }` groups with redirected output, and `cmd > log; rc=$?; tail log; exit "$rc"`
- Fewer commands count as test, build, or lint runs. A command counted when one of those words appeared anywhere in it, so reading a `*.test.ts` file or an inline script mentioning "check" did: 25,946 of 38,565 recorded commands. Now the program, its subcommand, or the script it runs has to be one: 10,294. This is what long runs use to pick "the last run of each test/build/lint command", where file reads had been taking the slots

## 1.7.1

- A read-only run no longer lists other writers' changes as its own. Changed files come from `git status` before and after the run, so a reviewer running beside an implementer in the same checkout reported the implementer's edits under "Files changed during the run": 14 of 136 recorded read-only runs did. Its sandbox cannot write in the repository, so those files now appear under "Changed in the repository meanwhile, not by this run", and "Files changed during the run" keeps only what the run could write (its `--writable-root` directories). In `--json` output they are `otherFiles`

## 1.7.0

- A dispatch whose turn is cut off by a temporary Codex error continues on the same thread instead of failing: after 20s, then 60s, then 120s, Codex is sent the assignment again with a note to pick up where it stopped. All 7 failed dispatches in the recorded history were of this kind ("Selected model is at capacity", "stream disconnected before completion"), and each was resumed by hand. The evidence block lists the cut-off turns, and their commands and file changes stay in it. Usage limits, a full context window, and other errors that waiting does not fix still fail at once. `CODEX_DISPATCH_RETRY_DELAYS` sets other waits (`5s,30s`) or turns retries off (`off`)
- A failed run no longer presents Codex's last progress note as its report. The report starts with "Codex stopped before writing its report" and the error, then quotes the note as a note. `/codex:status` shows the error as the job's summary

## 1.6.0

- Claude receives a dispatch report exactly as the plugin stored it. Until now the relay agent's model retyped it: the hook meant to substitute the plugin's output only runs in auto permission mode, the one mode where Claude Code gives subagents the `SubagentHandback` tool it intercepts. Of 630 recorded relay runs, 580 handed Claude an altered report: Codex's message shortened or reworded, the evidence block turned into prose, truncated commands filled in
- The relay runs `dispatch --relay` and `wait --relay`, which print two lines naming the job instead of the report, so the relay has nothing to rewrite. Hooks attach the stored report to the relay's result: as hook context on a background relay's completion notification (`UserPromptSubmit`), in place of a foreground relay's result (`PostToolUse` on `Agent`), and in place of the handback message in auto mode. On a notification, a report over 10,000 characters arrives as a file path with a preview. If no hook runs, the two lines say to run `/codex:result <job-id>`. Checked with Claude Code 2.1.325
- The relay guard denies dispatch and wait commands without `--relay`, and its message shows the command to run instead
- In the Claude Code interface a finished relay's own message is now those two lines; `/codex:result <job-id>` shows the report
- Records of relay results that never reached a caller are removed after 3 days. Before, every relay run left one behind

## 1.5.3

- Evidence shows the command Codex ran when Codex's quoting splits the `bash -c` argument into several quoted parts (for example `"rg -n '"'^a|^b'"' file"`, which it produces for an argument containing both quote kinds). Before, the command was displayed with leftover quote marks, and a `|` inside the quoted regex counted as a pipe, so the command got `?` and "exit N from the last command only" instead of `✓`

## 1.5.2

- Parallel dispatches no longer lose job records. Every job update read `state.json`, changed it, and wrote it back without a lock, so a process writing from an older read dropped the jobs recorded since then. It also deleted their job files and logs as if they had been pruned. With seven dispatches launched at once, two jobs vanished from `/codex:status` and `/codex:result`, although their Codex threads finished. Updates now hold a lock file next to `state.json` (taken over if its owner died or has held it for over 10 seconds), and they only delete the files of jobs they dropped from the state they read
- `state.json` and job files are written to a temp file and renamed into place, so a reader never sees a half-written file
- Ending a session removes its jobs through the same locked update

- Claude can run `/codex:result` and `/codex:status` itself (they were user-only), so it can collect a dispatch's report by job id after the relay agent that started it has gone. Both are read-only; `/codex:cancel` and `/codex:transfer` stay user-only
- A still-running dispatch checkpoint names those two commands above its `NEXT:` line, and the dispatch agent description says how to collect a report later
- Tests clear `CODEX_PLUGIN_SOURCE`, so a configured local source no longer leaks into them

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
