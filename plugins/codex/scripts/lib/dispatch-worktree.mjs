import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

const BRANCH_PREFIX = "codex-dispatch";

function git(cwd, args) {
  return runCommand("git", args, { cwd, shell: false });
}

function gitChecked(cwd, args, action) {
  const result = git(cwd, args);
  if (result.error || result.status !== 0) {
    throw new Error(`Could not ${action}: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  }
  return result.stdout.trim();
}

function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

function isRegisteredWorktree(repoRoot, worktreePath) {
  const list = git(repoRoot, ["worktree", "list", "--porcelain"]);
  return list.status === 0 && list.stdout.split("\n").some((line) => line === `worktree ${worktreePath}`);
}

/**
 * A git worktree for one write dispatch, so parallel dispatches cannot step on each other or on
 * the main checkout. It lives in the plugin's state directory rather than inside the repository,
 * so it adds nothing to the repository's `git status`.
 */
export function createDispatchWorktree(repoRoot, jobId, label = null) {
  const base = gitChecked(repoRoot, ["rev-parse", "HEAD"], "start a worktree (the repository needs at least one commit)");
  const slug = slugify(label);
  const branch = `${BRANCH_PREFIX}/${jobId}${slug ? `-${slug}` : ""}`;
  const worktreePath = path.join(resolveStateDir(repoRoot), "worktrees", jobId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  gitChecked(repoRoot, ["worktree", "add", "-b", branch, worktreePath, base], "create the worktree");
  return { path: fs.realpathSync.native(worktreePath), branch, base, repoRoot };
}

// A follow-up continues in the same worktree; if it was removed because the first run changed
// nothing, it is recreated on the same branch name.
export function ensureDispatchWorktree(worktree) {
  if (fs.existsSync(worktree.path) && isRegisteredWorktree(worktree.repoRoot, worktree.path)) {
    return worktree;
  }
  const branchExists = git(worktree.repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`]).status === 0;
  const args = branchExists
    ? ["worktree", "add", worktree.path, worktree.branch]
    : ["worktree", "add", "-b", worktree.branch, worktree.path, worktree.base];
  fs.mkdirSync(path.dirname(worktree.path), { recursive: true });
  gitChecked(worktree.repoRoot, args, "recreate the worktree");
  return worktree;
}

// Removes the worktree and its branch when the run left nothing in them.
export function finishDispatchWorktree(worktree) {
  const status = git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
  const ahead = git(worktree.path, ["rev-list", "--count", `${worktree.base}..HEAD`]);
  const unchanged = status.status === 0 && !status.stdout.trim() && ahead.status === 0 && ahead.stdout.trim() === "0";
  if (!unchanged) {
    return { ...worktree, removed: false };
  }
  git(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
  git(worktree.repoRoot, ["branch", "-D", worktree.branch]);
  return { ...worktree, removed: true };
}

export function renderWorktreeLines(worktree) {
  if (!worktree) {
    return [];
  }
  const header = `Worktree: ${worktree.path} · branch ${worktree.branch} · from ${worktree.base.slice(0, 12)}`;
  if (worktree.removed) {
    return [`${header} (removed: the run changed nothing)`];
  }
  return [
    header,
    "  Changes are uncommitted in the worktree; the main checkout is untouched.",
    `  Keep: git -C "${worktree.path}" add -A && git -C "${worktree.path}" commit -m "<message>" && git -C "${worktree.repoRoot}" merge ${worktree.branch}`,
    `  Discard: git -C "${worktree.repoRoot}" worktree remove --force "${worktree.path}" && git -C "${worktree.repoRoot}" branch -D ${worktree.branch}`
  ];
}
