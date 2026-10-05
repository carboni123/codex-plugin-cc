---
description: Diagnose the Codex plugin or a codex:dispatch job — loaded vs installed version, where the plugin source lives, dispatch settings, and for a job its settings, log, Codex session file, and stored report, plus known limitations. Use when a dispatch behaves unexpectedly.
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" troubleshoot "$ARGUMENTS"`

Present the output above to the user in full; do not summarize away paths, versions, or the log.

If it shows that this session runs an older plugin version than the one installed, say that /reload-plugins fixes it before anything else.

If the problem is a defect in the plugin itself, the fix belongs in the source named under "Where the plugin comes from" (the local checkout when one is configured, otherwise the repository), never in the installed cache, which updates overwrite.
