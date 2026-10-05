import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  diffWorkingTreeSnapshots,
  mergeFileChanges,
  snapshotWorkingTree
} from "../plugins/codex/scripts/lib/worktree-snapshot.mjs";

function write(repo, file, content) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

test("working tree snapshots catch writes the patch tool never reports", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  write(repo, "src/app.js", "v1\n");
  write(repo, "src/keep.js", "v1\n");
  write(repo, "src/gone.js", "v1\n");
  write(repo, "src/reverted.js", "v1\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Dirty before the run: one file stays as it is, one gets edited again, one gets reverted.
  write(repo, "src/keep.js", "local edit\n");
  write(repo, "notes.txt", "draft\n");
  write(repo, "src/reverted.js", "local edit\n");
  const before = snapshotWorkingTree(repo);

  write(repo, "src/app.js", "v2\n");
  write(repo, "notes.txt", "draft, edited during the run\n");
  write(repo, "generated/out.json", "{}\n");
  fs.rmSync(path.join(repo, "src/gone.js"));
  write(repo, "src/reverted.js", "v1\n");
  const after = snapshotWorkingTree(repo);

  assert.deepEqual(diffWorkingTreeSnapshots(before, after), [
    { path: "generated/out.json", change: "added" },
    { path: "notes.txt", change: "modified" },
    { path: "src/app.js", change: "modified" },
    { path: "src/gone.js", change: "deleted" },
    { path: "src/reverted.js", change: "restored to HEAD" }
  ]);
});

test("working tree snapshots return null outside a git repository", () => {
  assert.equal(snapshotWorkingTree(makeTempDir()), null);
  assert.equal(diffWorkingTreeSnapshots(null, null), null);
});

test("mergeFileChanges prefers git's view and keeps patch-only paths such as ignored files", () => {
  assert.deepEqual(
    mergeFileChanges(
      [{ path: "src/a.js", change: "modified" }],
      [{ path: "src/a.js", change: "added" }, { path: "dist/bundle.js", change: "modified" }]
    ),
    [
      { path: "dist/bundle.js", change: "modified" },
      { path: "src/a.js", change: "modified" }
    ]
  );
  assert.deepEqual(mergeFileChanges(null, [{ path: "a.js", change: "added" }]), [{ path: "a.js", change: "added" }]);
});
