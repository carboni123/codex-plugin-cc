import path from "node:path";

// What a reported exit code says about a command line Codex ran. The shell reports one exit code
// for the whole line, and for `a; b`, `a | b`, or `a || b` that is not every part's. The dispatch
// evidence uses this to tell three cases apart: the exit code covers the line, it misses parts
// that do not matter (file reads, `set -a`), or it misses a part that does (`pnpm test | tail`).

// Splits a command line into words as sh does for quotes and backslashes (no expansions).
// Returns null when a quote is left open.
function splitShellWords(text) {
  const words = [];
  let word = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (word != null) {
        words.push(word);
        word = null;
      }
      continue;
    }
    word ??= "";
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) {
        return null;
      }
      word += text.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      let closed = false;
      for (index += 1; index < text.length; index += 1) {
        const inner = text[index];
        if (inner === '"') {
          closed = true;
          break;
        }
        // Inside double quotes a backslash escapes only $ ` " \ and newline (a line continuation).
        if (inner === "\\" && '$`"\\\n'.includes(text[index + 1] ?? "")) {
          index += 1;
          word += text[index] === "\n" ? "" : text[index];
          continue;
        }
        word += inner;
      }
      if (!closed) {
        return null;
      }
    } else if (char === "\\") {
      index += 1;
      word += text[index] === "\n" ? "" : (text[index] ?? "");
    } else {
      word += char;
    }
  }
  if (word != null) {
    words.push(word);
  }
  return words;
}

// Codex runs commands through `bash -c`; show the command Codex actually meant. Undoing the
// outer quoting also matters for the analysis below: inside `bash -c "python3 -c \"a; b\""` the
// `;` is quoted, which only shows once `\"` is a quote again. Codex's quoting can also join
// several quoted parts into the one argument, e.g. `"rg -n '"'a|b'"' file"`.
export function unwrapShellCommand(command) {
  const text = String(command ?? "");
  const match = text.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/);
  if (!match) {
    return text;
  }
  const words = splitShellWords(match[1]);
  return words?.length === 1 ? words[0] : text;
}

// Splits a script at the operators that separate commands, outside quotes, backticks, and
// parentheses. Each part carries the operator that follows it: ";" (also a newline), "&&", "||",
// "|", "&", or null for the last. Returns null when quotes or parentheses do not balance.
function splitCommands(script) {
  const parts = [];
  let text = "";
  let depth = 0;
  const push = (op) => {
    const trimmed = text.trim();
    text = "";
    // Blank lines and comments separate nothing: the operator before them still applies.
    if (trimmed && !trimmed.startsWith("#")) {
      parts.push({ text: trimmed, op });
    } else if (op === null && parts.length > 0) {
      parts.at(-1).op = null;
    }
  };

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (char === "\\") {
      text += char + (script[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      let end = index + 1;
      for (; end < script.length && script[end] !== char; end += 1) {
        if (script[end] === "\\" && char !== "'") {
          end += 1;
        }
      }
      if (end >= script.length) {
        return null;
      }
      text += script.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "(" || char === ")") {
      depth += char === "(" ? 1 : -1;
      if (depth < 0) {
        return null;
      }
      text += char;
      continue;
    }
    if (depth === 0) {
      const pair = script.slice(index, index + 2);
      if (pair === "&&" || pair === "||" || pair === "|&") {
        push(pair === "|&" ? "|" : pair);
        index += 1;
        continue;
      }
      if (char === ";" || char === "\n" || char === "|") {
        push(char === "|" ? "|" : ";");
        continue;
      }
      // `2>&1` and `&>file` are redirections, not a background job.
      if (char === "&" && script[index - 1] !== ">" && script[index + 1] !== ">") {
        push("&");
        continue;
      }
    }
    text += char;
  }
  if (depth !== 0) {
    return null;
  }
  push(null);
  return parts;
}

// Loops, conditionals, and brace groups decide for themselves which exit code comes out.
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "case", "select", "function", "do", "done", "then", "else", "elif", "fi", "esac", "{", "}", "!", "[["]);

// Shell state and housekeeping. A failure here changes what the next command means, not whether it passed.
const SETUP_PROGRAMS = new Set(["set", "export", "unset", ".", "source", "cd", "pushd", "popd", "umask", "shopt", "trap", "ulimit", "sleep", "wait", "mkdir"]);
// Commands that only show something. Their exit code is not evidence of anything Codex claims.
const READ_PROGRAMS = new Set([
  "cat", "sed", "rg", "grep", "egrep", "fgrep", "head", "tail", "ls", "nl", "wc", "find", "fd", "cut", "sort", "uniq", "tr", "jq", "yq",
  "echo", "printf", "pwd", "which", "type", "stat", "file", "tree", "du", "df", "date", "basename", "dirname", "realpath", "readlink",
  "diff", "cmp", "column", "less", "more", "xxd", "od", "strings", "awk", "ast-grep", "sg", "ps", "pgrep", "uptime", "env", "printenv",
  "id", "whoami", "hostname", "uname", "test", "[", "tac", "rev", "fold", "paste", "comm", "md5sum", "sha1sum", "sha256sum", "shasum",
  "cksum", "tee", "seq", "command", "true", ":"
]);
const READ_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "grep", "blame", "describe", "merge-base", "cat-file", "show-ref",
  "shortlog", "reflog", "rev-list", "for-each-ref", "check-ignore", "diff-tree", "diff-index", "name-rev", "symbolic-ref", "whatchanged"
]);
// Commands that move files around. A file named like a test does not make them a test run.
const FILE_PROGRAMS = new Set(["cp", "mv", "rm", "rmdir", "touch", "ln", "chmod", "chown", "kill", "pkill", "install"]);
const INTERPRETERS = new Set(["node", "python", "python3", "bash", "sh", "zsh", "deno", "bun", "tsx", "ts-node", "ruby", "php", "perl"]);
// Prefixes that run the command after them.
const WRAPPERS = new Set(["env", "time", "exec", "nohup", "nice", "stdbuf", "timeout"]);
const VERIFICATION_WORD = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|unittest|jest|vitest|tsc|eslint|ruff|mypy|clippy|playwright)\b/i;

function isPathLike(word) {
  return word.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(word);
}

function classifyGitCommand(args) {
  if (args.includes("--check")) {
    // `git diff --check` fails on whitespace errors: it is run for its exit code.
    return "verify";
  }
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    index += args[index] === "-C" || args[index] === "-c" ? 2 : 1;
  }
  const [subcommand, ...rest] = args.slice(index);
  if (READ_GIT_SUBCOMMANDS.has(subcommand)) {
    return "read";
  }
  if (["branch", "remote", "tag"].includes(subcommand) && rest.every((arg) => /^-(-list|-show-current|[avlr]+)$/.test(arg))) {
    return "read";
  }
  if (["stash", "worktree"].includes(subcommand) && rest[0] === "list") {
    return "read";
  }
  return "other";
}

/**
 * What one simple command is for: "setup" (shell state), "read" (shows something), "verify" (a
 * test, build, lint, or check run for its result), or "other".
 */
function classifySimpleCommand(text) {
  const words = splitShellWords(text);
  if (!words) {
    return "other";
  }
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      continue;
    }
    if (!WRAPPERS.has(path.basename(word))) {
      break;
    }
    // Skip the wrapper's own arguments: timeout's options and duration, env's -i and -u NAME.
    const own = path.basename(word) === "timeout" ? /^(-|\d+(\.\d+)?[smhd]?$)/ : path.basename(word) === "env" ? /^-/ : null;
    while (own && index + 1 < words.length && own.test(words[index + 1])) {
      index += words[index + 1] === "-u" ? 2 : 1;
    }
  }
  if (index >= words.length) {
    // Only variable assignments.
    return "setup";
  }

  const program = path.basename(words[index]);
  const args = words.slice(index + 1);
  if (SETUP_PROGRAMS.has(program)) {
    return "setup";
  }
  if (program === "git") {
    return classifyGitCommand(args);
  }
  if (args.length === 1 && /^(--version|--help|-v|-V|-h|version)$/.test(args[0])) {
    return "read";
  }
  if (program === "gh" && ["view", "list", "diff", "status", "checks"].includes(args[1])) {
    return "read";
  }
  if (program === "docker" && ["ps", "port", "logs", "inspect", "images"].includes(args[0])) {
    return "read";
  }
  if (READ_PROGRAMS.has(program)) {
    const writes =
      (program === "sed" && args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"))) ||
      (program === "find" && args.some((arg) => ["-delete", "-exec", "-execdir", "-ok"].includes(arg)));
    return writes ? "other" : "read";
  }
  if (FILE_PROGRAMS.has(program)) {
    return "other";
  }

  // Words that name what is run: the program, its subcommands and options, and for an interpreter
  // the script. File arguments and inline code are left out, so `node -e '… test …'` and
  // `prettier --write a.test.ts` are not test runs.
  const named = [program, ...args.filter((arg) => !/\s/.test(arg) && !isPathLike(arg))];
  if (INTERPRETERS.has(program)) {
    const script = args.find((arg) => !arg.startsWith("-"));
    if (script && !/\s/.test(script)) {
      named.push(path.basename(script));
    }
  }
  return named.some((word) => VERIFICATION_WORD.test(word)) ? "verify" : "other";
}

// The inside of `( … )`, also when its output is redirected; null for anything else.
function subshellBody(text) {
  if (!text.startsWith("(") || text.startsWith("((")) {
    return null;
  }
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      index = text.indexOf(char, index + 1);
      if (index === -1) {
        return null;
      }
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        const redirections = /^(?:\s*(?:\d*>&\d+|&?\d*>>?\s*\S+|<\s*\S+))*\s*$/;
        return redirections.test(text.slice(index + 1)) ? text.slice(1, index) : null;
      }
    }
  }
  return null;
}

function stripKeywords(text) {
  return text.replace(/^(?:(?:if|elif|while|until|do|then|else|!)\s+)+/, "");
}

function firstWord(text) {
  return text.split(/\s+/, 1)[0];
}

/**
 * Breaks a command line into its simple commands and says, for each, what it is for and whether
 * the line's exit code would show its failure. Returns { understood: false, ... } for scripts
 * with loops, conditionals, or unbalanced quoting, where only the separators are known.
 */
function analyzeScript(script, outerCovered = true) {
  // `{ a && b; } > log` is its body with the output redirected.
  const group = script.trim().match(/^\{\s([^{}]*?);?\s*\}((?:\s*(?:\d*>&\d+|&?\d*>>?\s*\S+|<\s*\S+))*)\s*$/);
  if (group) {
    return analyzeScript(group[1], outerCovered);
  }
  const parts = splitCommands(script);
  if (!parts) {
    return { understood: false, stages: [], separated: /[;|\n]/.test(script) };
  }
  if (parts.some((part) => SHELL_KEYWORDS.has(firstWord(part.text)))) {
    return {
      understood: false,
      stages: parts.map((part) => ({ text: part.text, kind: classifySimpleCommand(stripKeywords(part.text)), covered: false })),
      separated: parts.length > 1
    };
  }

  // Lists are separated by ";" or "&"; inside a list, pipelines are joined by "&&" and "||";
  // inside a pipeline, stages are joined by "|".
  const lists = [{ pipelines: [{ stages: [] }] }];
  for (const part of parts) {
    const list = lists.at(-1);
    const pipeline = list.pipelines.at(-1);
    pipeline.stages.push(part.text);
    if (part.op === "&&" || part.op === "||") {
      pipeline.op = part.op;
      list.pipelines.push({ stages: [] });
    } else if (part.op === ";" || part.op === "&") {
      list.separator = part.op;
      lists.push({ pipelines: [{ stages: [] }] });
    }
  }
  if (lists.at(-1).pipelines[0].stages.length === 0) {
    lists.pop();
  }

  const first = splitShellWords(lists[0]?.pipelines[0].stages[0] ?? "") ?? [];
  const setFlags = first[0] === "set" ? first.slice(1) : [];
  const errexit = setFlags.some((flag) => /^-[A-Za-z]*e/.test(flag) || flag === "errexit");
  const pipefail = setFlags.includes("pipefail");
  // `cmd > log; rc=$?; tail log; exit "$rc"` hands the line cmd's exit code.
  const exited = lists.at(-1)?.pipelines.at(-1).stages.at(-1)?.match(/^exit\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/)?.[1];
  const capture = exited ? lists.findLastIndex((list) => list.pipelines.length === 1 && list.pipelines[0].stages.join() === `${exited}=$?`) : -1;

  const stages = [];
  let understood = true;
  lists.forEach((list, listIndex) => {
    const lastList = listIndex === lists.length - 1;
    list.pipelines.forEach((pipeline, pipelineIndex) => {
      const lastPipeline = pipelineIndex === list.pipelines.length - 1;
      // In the last list, `a && b` fails when either does. Before it, only `set -e` stops the
      // script, and only for the final command of a list.
      const andChainToEnd = list.pipelines.slice(pipelineIndex, -1).every((entry) => entry.op === "&&");
      const handedOn = lastPipeline && list.separator === ";" && (errexit || listIndex === capture - 1);
      const pipelineCovered = outerCovered && (lastList ? andChainToEnd : handedOn);
      pipeline.stages.forEach((text, stageIndex) => {
        // Saving `$?` cannot fail, so it is never the part an exit code leaves out.
        const covered = (pipelineCovered && (stageIndex === pipeline.stages.length - 1 || pipefail)) || /^[A-Za-z_][A-Za-z0-9_]*=\$\?$/.test(text);
        const body = subshellBody(text);
        if (body != null) {
          const inner = analyzeScript(body, covered);
          understood &&= inner.understood;
          stages.push(...inner.stages);
        } else {
          stages.push({ text, kind: classifySimpleCommand(text), covered });
        }
      });
    });
  });
  return { understood, stages, separated: parts.length > 1 };
}

/**
 * Describes what a line's exit code leaves out:
 * - compound: some part's failure would not show in the exit code
 * - unchecked: the most important such part, as { kind: "verification", command }, { kind: "other" },
 *   or { kind: "setup" }; null when everything is covered or only file reads are not
 * - verification: the line runs a test, build, lint, or check
 */
export function analyzeShellCommand(command) {
  let text = String(command ?? "").trim();
  // A here-document's body spans lines but belongs to one command.
  if (text.includes("<<")) {
    text = text.split(/\r?\n/)[0];
  }
  const { understood, stages, separated } = analyzeScript(text);
  const verification = stages.length > 0 ? stages.some((stage) => stage.kind === "verify") : VERIFICATION_WORD.test(text);
  if (!understood) {
    return { compound: separated, unchecked: separated ? { kind: "other" } : null, verification };
  }
  const hidden = stages.filter((stage) => !stage.covered);
  const hiddenVerification = hidden.find((stage) => stage.kind === "verify");
  const unchecked = hiddenVerification
    ? { kind: "verification", command: hiddenVerification.text }
    : hidden.some((stage) => stage.kind === "other")
      ? { kind: "other" }
      : hidden.some((stage) => stage.kind === "setup")
        ? { kind: "setup" }
        : null;
  return { compound: hidden.length > 0, unchecked, verification };
}

/**
 * True when a shell command runs several commands whose exit codes the shell does not combine:
 * `a; b`, `a | b`, `a || b`, or one command per line. `a && b` chains and `set -e` scripts stop
 * at the first failure, so their exit code does speak for the whole line.
 */
export function isCompoundCommand(command) {
  return analyzeShellCommand(command).compound;
}

export function looksLikeVerificationCommand(command) {
  return analyzeShellCommand(command).verification;
}
