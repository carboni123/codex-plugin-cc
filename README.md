# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs
- `codex:dispatch`, a subagent type Claude can use instead of its own subagents, so delegated work runs on Codex while Claude orchestrates

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add openai/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@openai-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:troubleshoot`

Diagnoses the plugin, or one dispatch job when you pass its id. It shows:

- the plugin version this session loaded and the one installed (a mismatch means `/reload-plugins`), and the Codex CLI version
- where the plugin comes from: the repository, and a local checkout if `CODEX_PLUGIN_SOURCE` points to one, with how to ship a fix (the installed copy is a cache that updates overwrite)
- the dispatch settings in effect (`CODEX_DISPATCH_*`), the job state directory, and this workspace's shared broker
- for a job: its settings, workspace, follow-up chain, recent activity log, the Codex session file that records every call (including ones the sandbox refused), and the report the plugin returned
- the known limitations of the evidence and the relay

Claude can run it on its own when a dispatch fails or looks wrong; failed and cancelled dispatch reports end with the exact command.

```bash
/codex:troubleshoot
/codex:troubleshoot dispatch-mg2k1c-x81
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Replacing Claude Subagents With Codex

`codex:dispatch` is a subagent type that does the same job as a Claude subagent, but on Codex. Anywhere Claude would spawn `general-purpose`, an implementer, or a research agent, it can pass the same prompt to `codex:dispatch` instead:

```text
Agent(subagent_type: "codex:dispatch", description: "Fix flaky auth test", prompt: "...")
```

Because it is an ordinary subagent, it keeps everything the Agent tool gives you: background runs with a notification when they finish, parallel fan-out, and follow-ups through `SendMessage`, which continue the same Codex thread. For parallel write runs, use the `--worktree` directive below rather than the Agent tool's `isolation: "worktree"`: the plugin then creates, reports, and cleans up the worktree itself. A Sonnet relay forwards the prompt verbatim and polls until Codex finishes; Codex does the work. The relay cannot reword what comes back: a plugin hook replaces its final message with the plugin's own output, so Claude receives Codex's report and the evidence block exactly as the plugin produced them. (The hook intercepts Claude Code's internal handback tool for background agents; if that tool changes, the relay's own message passes through instead.)

To make Claude prefer it, say so in the conversation or in `CLAUDE.md`, for example: "Delegate implementation and research subagent work to `codex:dispatch`."

**Options.** The Agent tool only carries a prompt, so options go on the prompt's first line:

```text
--read-only --effort high --label auth-audit
Find every place the session token is parsed and check each one for missing expiry validation.
```

| Directive | Effect |
| --- | --- |
| `--read-only` | Read-only sandbox, for investigation and research. Without it, the run is write-capable, like a `general-purpose` subagent. |
| `--worktree` | Run Codex in its own git worktree, on a new branch from the current commit, so parallel write dispatches cannot collide and the main checkout stays untouched. The worktree lives in the plugin's state directory. The report gives its path and branch with commands to keep (commit and merge) or discard the changes; if Codex changed nothing, the worktree and branch are removed. Follow-ups continue in the same worktree. |
| `--writable-root <dir>` | An extra directory Codex may write; repeat it for more. On a write run, it adds to the repository. On a `--read-only` run, the repository stays read-only and Codex runs from the first writable root. That makes a reviewer setup: read-only code, a writable scratch directory, and `--network` for loopback services. |
| `--prompt-file <path>` | Read the task from a file, relative to the repository. Then the first line is the whole prompt, so the relay forwards one line instead of retyping a long assignment. Also use this when a task contains the line `CODEX_DISPATCH_PROMPT_EOF`, which the relay cannot forward inline. |
| `--cwd <dir>` | Run in another directory or repository |
| `--network` / `--no-network` | Turn network access on or off: loopback ports, local services, Docker, and the internet. Write runs default to on, like a Claude subagent. Read-only runs default to off, because network access reaches local services and the Docker socket, through which a read-only run could still change state. |
| `--effort <low\|medium\|high\|xhigh\|max\|ultra>` | Codex reasoning effort (supported levels depend on the model) |
| `--model <name\|sol\|astra\|spark>` | Codex model. Aliases: `sol` = `gpt-6.1-sol`, `astra` = `gpt-6-astra`, `spark` = `gpt-5.3-codex-spark` |
| `--label <name>` | Name shown in `/codex:status` and the Codex thread list |
| `--raw` | Send the prompt without the delegated-worker contract described below |

A follow-up (a message to the same agent, or `--resume <job-id>`) keeps the sandbox, network, writable roots, model, effort, and `--raw` setting of the run it continues, unless its own first line changes them.

Without a directive, a dispatch falls back to these environment variables, then to the defaults above and to Codex's own config (`~/.codex/config.toml`) for model and effort: `CODEX_DISPATCH_MODEL`, `CODEX_DISPATCH_EFFORT`, `CODEX_DISPATCH_NETWORK` (`on`/`off`), and `CODEX_DISPATCH_WRITABLE_ROOTS` (paths separated by `:`). To make every dispatch default to high effort, set the variable in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CODEX_DISPATCH_EFFORT": "high" } }
```

**What Codex is told.** Each task is wrapped in a delegated-worker contract. It tells Codex that a Claude orchestrator only sees its final message and nobody can answer questions mid-run. Codex is asked to:

- work autonomously, stay in scope, and not commit unless asked
- verify its work
- end with a fixed report: Outcome, Details, Verification, Open issues

**What Claude gets back.** Codex's report, followed by an evidence block that the plugin builds from the app-server event stream, not from anything Codex wrote:

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

`/codex:status` also lists this session's dispatches that ran in another workspace (through `--cwd`, or from a worktree the Agent tool created), marked with that workspace; `/codex:status <id>`, `/codex:result <id>`, `/codex:cancel <id>`, and `wait <id>` find a job by id in any workspace.

"Files changed during the run" comes from comparing `git status` (with content hashes) before and after the run, merged with the edits Codex's patch tool reports. It catches files written by shell commands, formatters, or generators too. It also includes anything else that changed the working tree during the run, so give parallel write dispatches their own worktree with `--worktree`.

A `?` instead of `✓` marks a compound command (`a; b`, `a | b`, `a || b`, or several lines): the shell reports only the last part's exit code, so `pnpm test | tail` exits 0 even when the tests fail. `a && b` chains keep their `✓`, because they stop at the first failure.

The command list comes from Codex's app-server event stream. That stream sends nothing for a command or an edit the sandbox refuses, so the list can be shorter than what Codex attempted; Codex's own session log under `~/.codex/sessions` has every call.

Claude can check Codex's claims against this block. If the report says "tests pass" but the evidence shows a failing test run, Claude can see the mismatch.

**Shell environment.** Dispatched runs use a non-login shell, so Codex's commands see the same `PATH` as Claude Code's Bash tool. Codex's default login shell re-reads `/etc/profile`, which on Debian and Ubuntu rebuilds `PATH` and drops tools installed through version managers like nvm.

**Collecting results later.** Claude can run `/codex:status <job-id>` and `/codex:result <job-id>` itself, from any workspace, so a dispatch's report can still be collected after the relay agent that started it has gone. A still-running checkpoint says so above its `NEXT:` line.

**Long runs and stopping.** Each dispatch is a tracked background job, so it shows up in `/codex:status`, `/codex:result`, and `/codex:cancel`. The relay checks in about every 100 seconds, so recent Codex activity shows up in the agent's transcript while it works. Stopping the agent stops Codex too: when the waiting process is terminated, the job is cancelled and the Codex turn interrupted.

**Without the relay.** The `SessionStart` hook exports `CODEX_COMPANION_ROOT`, so the main Claude thread can also dispatch directly with a background Bash command and get notified when it exits:

```bash
node "$CODEX_COMPANION_ROOT/scripts/codex-companion.mjs" dispatch --timeout none <<'EOF'
--read-only
Map every caller of resolveWorkspaceRoot and note which ones assume a git checkout.
EOF
```

`dispatch --timeout 0` returns a job id right away, and `wait <job-id> [--timeout 5m]` picks it up later. Add `--json` to either for machine-readable output.

**`codex:dispatch` vs `/codex:rescue`.** `/codex:rescue` is for you: hand Codex a problem from the prompt, with thread-reuse questions and Codex's output shown verbatim. `codex:dispatch` is for Claude: a subagent replacement that Claude orchestrates, runs in parallel, and checks against evidence.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

Commands share one Codex app server per workspace through a small broker process, so later commands skip the startup cost. The broker shuts down after 5 minutes without a client (`CODEX_COMPANION_BROKER_IDLE_MS` changes this), and the `SessionEnd` hook stops it when the session ends.

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).
