# Codex plugin for Claude Code

Use Codex from Claude Code to review code, delegate tasks, and run Codex in place of Claude subagents.

Fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), maintained at [carboni123/codex-plugin-cc](https://github.com/carboni123/codex-plugin-cc).

## Requirements

- A ChatGPT plan (including Free) or an OpenAI API key. Usage counts toward your [Codex limits](https://developers.openai.com/codex/pricing).
- Node.js 18.18 or later

## Install

```bash
/plugin marketplace add carboni123/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

`/codex:setup` checks that the Codex CLI is installed and signed in, and can install it with npm. To do it yourself: `npm install -g @openai/codex`, then `!codex login`.

To update: `claude plugin marketplace update openai-codex && claude plugin update codex@openai-codex`, then `/reload-plugins`.

## Commands

| Command | What it does |
| --- | --- |
| `/codex:review [--base <ref>] [--background]` | Read-only Codex review of uncommitted changes, or of the branch against `<ref>` |
| `/codex:adversarial-review [--base <ref>] [focus…]` | Read-only review that challenges the design, tradeoffs, and assumptions; takes focus text |
| `/codex:rescue [--background] [--resume\|--fresh] [--model …] [--effort …] <task>` | Hand Codex a task (investigate, fix, continue a previous run) through the `codex:codex-rescue` subagent |
| `/codex:transfer` | Turn the current Claude session into a Codex thread you can continue with `codex resume` |
| `/codex:status [job-id]` | Running and recent jobs |
| `/codex:result [job-id]` | A finished job's output and its Codex session id |
| `/codex:cancel [job-id]` | Cancel a background job |
| `/codex:troubleshoot [job-id]` | Loaded vs installed version, settings, and for a job its log, Codex session file, and report |
| `/codex:setup [--enable-review-gate\|--disable-review-gate]` | Check that Codex is ready; toggle the review gate |

Long reviews and tasks can run with `--background`; check on them with `/codex:status` and `/codex:result`. Model aliases: `sol` = `gpt-6.1-sol`, `astra` = `gpt-6-astra`, `spark` = `gpt-5.3-codex-spark`. Without `--model` or `--effort`, Codex uses its own config.

**Review gate.** When enabled, a `Stop` hook has Codex review Claude's response and blocks the stop if it finds issues. It can loop and drain usage limits, so enable it only while you watch the session.

## `codex:dispatch`: Codex as a Claude subagent

`codex:dispatch` takes the prompt you would give `general-purpose`, an implementer, or a research agent, and Codex does the work. It keeps what the Agent tool provides: background runs, parallel fan-out, and follow-ups through `SendMessage` that continue the same Codex thread. A small relay agent forwards the prompt and waits; the plugin's hooks then give Claude the report exactly as stored, so no model retypes it. To make Claude prefer it, say so in `CLAUDE.md`, e.g. "Delegate implementation and research subagent work to `codex:dispatch`."

Options go on the prompt's first line:

```text
--read-only --effort high --label auth-audit
Find every place the session token is parsed and check each one for missing expiry validation.
```

| Option | Effect |
| --- | --- |
| `--read-only` | Read-only sandbox. Without it the run can write, like `general-purpose`. |
| `--worktree` | Run in its own git worktree and branch, so parallel write runs cannot collide. The report gives keep/discard commands; an unchanged worktree is removed. |
| `--writable-root <dir>` | Extra writable directory (repeatable). With `--read-only`, the repository stays read-only and Codex runs in this directory. |
| `--network` / `--no-network` | Network access, including local services and Docker. On by default for write runs, off for read-only. |
| `--prompt-file <path>` | Read the task from a file |
| `--cwd <dir>` | Run in another directory or repository |
| `--model <name\|sol\|astra\|spark>`, `--effort <level>` | Codex model and reasoning effort |
| `--label <name>` | Name shown in `/codex:status` |
| `--raw` | Send the task without the report contract below |

A turn cut off by a temporary Codex error (model at capacity, a dropped stream) is continued on the same thread after 20s, then 60s, then 120s, and the evidence says so. `CODEX_DISPATCH_RETRY_DELAYS` sets other waits (`5s,30s`) or turns this off (`off`).

Follow-ups keep the settings of the run they continue. Defaults come from `CODEX_DISPATCH_MODEL`, `CODEX_DISPATCH_EFFORT`, `CODEX_DISPATCH_NETWORK` (`on`/`off`), and `CODEX_DISPATCH_WRITABLE_ROOTS` (`:`-separated), which you can set in the `env` block of `~/.claude/settings.json`.

**What comes back.** Codex is told to work on its own, stay in scope, not commit unless asked, verify its work, and end with an Outcome / Details / Verification / Open issues report. The plugin appends evidence it observed itself:

```text
---
Codex dispatch evidence (observed by the plugin runtime, not written by Codex):
Status: completed · 4m 12s · job dispatch-mg2k1c-x81 · thread thr_19
Sandbox: workspace-write · network on · cwd: /repo
Files changed during the run (2):
  modified: src/auth/session.ts
  added: src/auth/session.test.ts
Commands reported: 14, 2 with non-zero exit (commands and edits the sandbox refused are not reported)
  (showing 6: the last run of each test/build/lint command and the last 5 commands)
  ✓ npm test -- session (exit 0)
  ✓ git diff --stat (exit 0)
  ✗ rg -n "expiresAt" src/legacy (exit 1)
  ✓ sed -n 1,80p src/auth/session.ts (exit 0)
  ✓ npx tsc --noEmit (exit 0)
  ✗ npm run lint (exit 1)
Follow up: send a message to this agent, or dispatch with --resume dispatch-mg2k1c-x81
```

- Changed files come from `git status` before and after the run plus Codex's own edits, so a write run's list includes anything else that changed the working tree meanwhile. Give parallel write runs `--worktree`. A read-only run cannot have made such changes, so it lists them apart, as changed "not by this run".
- `?` instead of `✓` means the exit code leaves out a part that matters. For a test, build, or lint run it names the part: `pnpm test | tail` shows "exit 0, but not from `pnpm test`". Any other hidden command that does more than read files shows "exit 0 from the last command only". Lines whose unchecked parts only read files or set up the shell (`set -a; . ./.env; set +a; pnpm test`) keep their `✓`.
- Commands the sandbox refused are not reported; Codex's session log under `~/.codex/sessions` has every call.

**How it reaches Claude.** The relay agent never sees the report. When Codex is done, the relay returns two lines that name the job, and hooks attach the stored report to that result: as hook context on a background agent's completion notification, or in place of a foreground agent's result. A report over 10,000 characters arrives on a notification as a file path with a preview, and Claude reads the file. In the Claude Code interface the agent's own message is those two lines; `/codex:result <job-id>` shows the report, and it is what Claude runs if a result arrives without one.

**Jobs.** Each dispatch is a background job. `/codex:status`, `/codex:result`, and `/codex:cancel` find it by id from any workspace, so Claude can collect a report after the relay agent is gone. Stopping the agent cancels the Codex run. The main thread can also dispatch without the relay:

```bash
node "$CODEX_COMPANION_ROOT/scripts/codex-companion.mjs" dispatch --timeout none <<'EOF'
--read-only
Map every caller of resolveWorkspaceRoot and note which ones assume a git checkout.
EOF
```

`--timeout 0` returns a job id at once, and `wait <job-id>` collects the result later.

## Configuration

The plugin drives your local Codex CLI through the [Codex app server](https://developers.openai.com/codex/app-server), with your existing sign-in and [config](https://developers.openai.com/codex/config-basic). Set the default model and effort in `~/.codex/config.toml`, or per project in `.codex/config.toml` (loaded only for [trusted projects](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)):

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
```

Commands in a workspace share one app server through a broker, which exits after 5 minutes idle (`CODEX_COMPANION_BROKER_IDLE_MS`) or when the session ends. Any job can be continued in Codex with `codex resume <session-id>`; `/codex:result` shows the id.

## Development

`npm test` runs the suite. See [AGENTS.md](AGENTS.md) for conventions and release steps.
