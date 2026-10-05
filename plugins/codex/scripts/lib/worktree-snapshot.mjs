import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";

// Large files are compared by size and mtime instead of content.
const MAX_HASHED_FILE_BYTES = 8 * 1024 * 1024;

function fingerprintFile(absolutePath) {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_HASHED_FILE_BYTES) {
      return `stat:${stat.size}:${stat.mtimeMs}`;
    }
    return crypto.createHash("sha1").update(fs.readFileSync(absolutePath)).digest("hex");
  } catch {
    return "missing";
  }
}

/**
 * Records every path git reports as modified, deleted, or untracked, with a fingerprint of
 * its content. Comparing two snapshots shows what changed during a run however it was
 * written: Codex's patch tool, a shell redirect, a formatter, or a code generator.
 * Returns null outside a git repository.
 */
export function snapshotWorkingTree(root) {
  const result = runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  const entries = new Map();
  const fields = result.stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) {
      continue;
    }
    const status = field.slice(0, 2);
    const filePath = field.slice(3);
    // Renames and copies are followed by their source path as a separate field.
    if (status[0] === "R" || status[0] === "C") {
      index += 1;
    }
    entries.set(filePath, { status, fingerprint: fingerprintFile(path.join(root, filePath)) });
  }
  return entries;
}

function describeChange(entry, previous) {
  if (entry.status.includes("D")) {
    return "deleted";
  }
  if (!previous && (entry.status === "??" || entry.status.includes("A"))) {
    return "added";
  }
  return "modified";
}

export function diffWorkingTreeSnapshots(before, after) {
  if (!before || !after) {
    return null;
  }
  const changes = [];
  for (const [filePath, entry] of after) {
    const previous = before.get(filePath);
    if (previous && previous.status === entry.status && previous.fingerprint === entry.fingerprint) {
      continue;
    }
    changes.push({ path: filePath, change: describeChange(entry, previous) });
  }
  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      // Dirty before the run, clean after: the file was put back to its committed state.
      changes.push({ path: filePath, change: "restored to HEAD" });
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Merges the git snapshot diff with the files Codex's patch tool reported. Git catches writes
 * the event stream never sees; the patch events still cover gitignored files.
 */
export function mergeFileChanges(gitChanges, patchChanges) {
  if (!gitChanges) {
    return patchChanges;
  }
  const byPath = new Map(gitChanges.map((entry) => [entry.path, entry]));
  for (const entry of patchChanges) {
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
