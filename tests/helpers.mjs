import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Each test process gets one throwaway root. Temp repositories and plugin state live under it
// and are deleted on exit, so test runs neither litter /tmp nor touch a developer's real
// plugin data. Variables a Claude Code session exports would otherwise leak into the tests.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-tests-"));
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_ROOT",
  "CODEX_COMPANION_EVENT_LOG",
  "CODEX_DISPATCH_MODEL",
  "CODEX_DISPATCH_EFFORT",
  "CODEX_DISPATCH_NETWORK",
  "CODEX_DISPATCH_WRITABLE_ROOTS"
]) {
  delete process.env[name];
}
process.env.CLAUDE_PLUGIN_DATA = path.join(TEST_ROOT, "plugin-data");
// Brokers started by tests exit soon after their last client instead of after five minutes.
process.env.CODEX_COMPANION_BROKER_IDLE_MS = "1500";
process.on("exit", () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(TEST_ROOT, prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
