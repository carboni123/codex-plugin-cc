# AGENTS.md

Claude Code plugin that drives the Codex CLI: reviews, rescue tasks, and `codex:dispatch` subagents.

## Layout

- `plugins/codex/` — the plugin: `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, `prompts/`, `schemas/`
- `plugins/codex/scripts/codex-companion.mjs` — CLI entry point; shared code in `scripts/lib/` (job state in `state.mjs`, dispatch evidence in `dispatch.mjs`)
- `tests/` — `node:test` suites; `helpers.mjs` isolates plugin state per test process, `fake-codex-fixture.mjs` stands in for Codex

## Conventions

- Plain ESM `.mjs` on Node ≥ 18.18, no runtime dependencies.
- Several processes (dispatch workers, hooks, commands) share job state: change it only through `updateState`/`upsertJob`.
- Commits: `feat|fix(scope): summary`, with a body explaining why.

## Checks

- `npm test` must pass. "task logs subagent reasoning…" in `runtime.test.mjs` is flaky under load (it predates current work).
- `npm run build` type-checks against generated app-server types and needs the `codex` CLI installed.

## Releasing

Every user-visible change ships as its own version:

1. `npm run bump-version -- <x.y.z>` (updates all four version files) and add a `plugins/codex/CHANGELOG.md` entry.
2. Push to `main`; the `openai-codex` marketplace installs from it.
3. `claude plugin marketplace update openai-codex && claude plugin update codex@openai-codex`, then `/reload-plugins`.

Never edit the installed copy under `~/.claude/plugins/cache/`; updates overwrite it.
