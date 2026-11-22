import type { ApprovalRisk, ItemOf } from "@codeden/contracts";
import { parseShell, type SimpleCommand } from "@codeden/providers";
import { isLocalCommand } from "./local-commands";

type ApprovalItem = ItemOf<"approval_request">;

/**
 * CodeDen's own verdict on an approval, for the plain-words card (§11.2): whether the action
 * can be undone, and its traffic-light risk. Decided from the request itself (its command and
 * the action and reason the risk classifier gave it), never from what an agent or the utility
 * model says. Anything not recognised as reversible counts as not undoable.
 */
export interface UndoRiskContext {
  /**
   * The session works in a worktree of its own, so its turn checkpoints (§9) can put back what
   * an edit or a command changed there.
   */
  inWorktree?: boolean;
}

export interface UndoRisk {
  undoable: boolean;
  risk: ApprovalRisk;
  /** The action deletes something (`rm`, `git clean`, `find -delete`, `Remove-Item`, ...). */
  deletes: boolean;
  /** Plain-words reason why the action cannot be undone, when known. */
  reason?: string;
}

/** The reason providers give an action that asks only because the level is Supervised. */
const SUPERVISED_ONLY = /^Supervised mode:/;

/** Programs that put their arguments in the Trash (or the desktop's equivalent). */
const TRASH_TOOLS = new Set(["trash", "trash-put", "gtrash", "trash-cli"]);

/** Programs that delete their arguments for good. */
const DELETERS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
]);

/** Programs that destroy data in other ways (overwrite, format, truncate). */
const DESTROYERS = new Set(["dd", "truncate", "mkfs", "wipefs", "diskutil", "format", "fdisk"]);

/** Commands that only read or print, so there is nothing to undo. */
const READ_ONLY = new Set([
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "less",
  "wc",
  "echo",
  "printf",
  "pwd",
  "stat",
  "file",
  "du",
  "df",
  "which",
  "whoami",
  "grep",
  "rg",
  "tree",
  "test",
  "true",
  "get-childitem",
  "get-content",
  "get-item",
]);

/** Read-only git subcommands. */
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse"]);

/** Wrappers whose arguments are the real command (`sudo rm`, `env X=1 rm`). */
const WRAPPERS = new Set(["sudo", "env", "command", "builtin", "exec", "nohup", "time", "doas"]);

const MOVERS = new Set(["mv", "move", "move-item", "mi"]);

/** The program and its arguments, past wrappers and `VAR=value` assignments. */
function programWords(cmd: SimpleCommand): string[] {
  const words = [...cmd.words];
  while (words.length > 0) {
    const first = words[0] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || WRAPPERS.has(baseName(first))) {
      words.shift();
      while (words.length > 0 && (words[0] as string).startsWith("-")) words.shift();
      continue;
    }
    break;
  }
  return words;
}

function baseName(word: string): string {
  return (
    word
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? ""
  );
}

/** A path inside a user's Trash folder (`~/.Trash`, `$HOME/.Trash/x`, `/Users/me/.Trash`). */
function isTrashPath(word: string): boolean {
  return /(^|[\\/])\.Trash([\\/]|$)/.test(word);
}

/**
 * `local`: a command CodeDen knows changes only files where it runs ({@link isLocalCommand}),
 * which a checkpoint of the worktree can put back. `other`: anything else, unknown included.
 */
type Kind = "trash" | "read_only" | "local" | "delete" | "destroy" | "other";

interface Classified {
  kind: Kind;
  reason?: string;
}

/**
 * `git checkout` without `--`: whether its operands are paths, a branch, or can't be told apart
 * without looking at the repository. `.`, `./x`, `/x`, `~/x` can't be branch names, and a ref
 * followed by more names (`HEAD src/a.ts`) restores paths: `path`. Creating or detaching
 * (`-b`, `--detach`) is `branch`. A lone name (`main`, `src/a.ts`) is a valid branch name and a
 * valid path: `ambiguous`.
 */
function checkoutForm(args: string[]): "path" | "branch" | "ambiguous" {
  const rest = args.slice(args.indexOf("checkout") + 1);
  if (rest.some((a) => /^(-b|-B|--orphan|--detach|-d|-t|--track)/.test(a))) return "branch";
  const names = rest.filter((a) => !a.startsWith("-"));
  if (names.length === 0) return "branch";
  if (names.length > 1) return "path";
  return /^(\.{1,2}(\/|$)|\/|~)/.test(names[0] ?? "") ? "path" : "ambiguous";
}

function classify(cmd: SimpleCommand): Classified {
  const words = programWords(cmd);
  const program = baseName(words[0] ?? "");
  const args = words.slice(1);
  if (!program) return { kind: "read_only" };
  if (TRASH_TOOLS.has(program)) return { kind: "trash" };
  if (program === "gio" && args[0] === "trash") return { kind: "trash" };
  if (
    program === "osascript" &&
    /\bfinder\b/i.test(args.join(" ")) &&
    /\bdelete\b/i.test(args.join(" "))
  ) {
    // Finder's `delete` moves items to the Trash.
    return { kind: "trash" };
  }
  if (MOVERS.has(program)) {
    const last = args.filter((a) => !a.startsWith("-")).pop();
    return { kind: last && isTrashPath(last) ? "trash" : "local" };
  }
  if (DELETERS.has(program)) return { kind: "delete" };
  if (DESTROYERS.has(program)) return { kind: "destroy" };
  if (program === "find") {
    if (args.includes("-delete")) return { kind: "delete" };
    if (args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok"))
      return { kind: "other" };
    return { kind: "read_only" };
  }
  if (program === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "clean" || sub === "rm") return { kind: "delete" };
    if (sub === "branch" && args.some((a) => a === "-D" || a === "-d" || a === "--delete")) {
      return { kind: "delete" };
    }
    if (sub === "push" && args.some((a) => a === "--delete" || a === "-d"))
      return { kind: "delete" };
    if (sub && READ_ONLY_GIT.has(sub) && args.length <= 2) return { kind: "read_only" };
    if (sub === "checkout") {
      const form = args.includes("--") ? "path" : checkoutForm(args);
      // throws away unsaved edits to that file
      if (form === "path")
        return { kind: "other", reason: "throws away unsaved edits to that file" };
      // A lone name may switch branches or restore a file: not undoable, no claim about which.
      if (form === "ambiguous") return { kind: "other" };
    }
    if (sub === "restore") {
      const stagedOnly =
        (args.includes("--staged") || args.includes("-S")) &&
        !args.includes("--worktree") &&
        !args.includes("-W");
      if (!stagedOnly) {
        // throws away unsaved edits to that file
        return { kind: "other", reason: "throws away unsaved edits to that file" };
      }
    }
    return { kind: isLocalCommand(program, args) ? "local" : "other" };
  }
  if (READ_ONLY.has(program)) return { kind: "read_only" };
  return { kind: isLocalCommand(program, args) ? "local" : "other" };
}

function flatten(cmds: SimpleCommand[]): SimpleCommand[] {
  return cmds.flatMap((c) => [c, ...c.nested.flatMap(flatten)]);
}

/**
 * Whether an approval's action can be undone and how risky it is (see {@link UndoRisk}).
 * - Undoable: a command made only of moves to the Trash and reads, with no redirect writing a
 *   file. In a session with its own worktree (`context.inWorktree`), also an edit the risk
 *   classifier kept inside it (`file_change`), or a `command` made only of reads and commands
 *   CodeDen knows stay local ({@link isLocalCommand}), redirects included: its checkpoints can
 *   put it back. Unknown programs, tools, network, package installs (which touch git-ignored
 *   `node_modules`) and anything outside the worktree count as not undoable.
 * - Red: secrets access, destructive git, or a deletion that can't be undone outside the
 *   worktree. Green: it asks only because the level is Supervised and deletes nothing for good.
 *   Yellow: everything else.
 */
export function undoRisk(item: ApprovalItem, context: UndoRiskContext = {}): UndoRisk {
  let kinds: Kind[] = ["other"];
  let writes = false;
  let notUndoableReason: string | undefined;
  if (item.command?.trim()) {
    try {
      const cmds = flatten(parseShell(item.command));
      if (cmds.length > 0) {
        const classified = cmds.map(classify);
        kinds = classified.map((c) => c.kind);
        notUndoableReason = classified.find((c) => c.reason)?.reason;
      } else {
        kinds = ["other"];
      }
      writes = cmds.some((c) => c.writes.length > 0);
    } catch {
      kinds = ["other"];
    }
  }
  const deletes = kinds.includes("delete") || kinds.includes("destroy");
  const trashOrRead = kinds.every((k) => k === "trash" || k === "read_only");
  const inWorktree = context.inWorktree === true;
  const checkpointed =
    inWorktree &&
    (item.action === "file_change" ||
      (item.action === "command" &&
        kinds.every((k) => k === "trash" || k === "read_only" || k === "local")));
  const undoable = !deletes && (checkpointed || (trashOrRead && !writes));
  const lostForGood = deletes && !undoable;

  let risk: ApprovalRisk = "yellow";
  if (
    item.action === "secrets" ||
    item.action === "git_destructive" ||
    (item.action === "outside_worktree" && lostForGood)
  ) {
    risk = "red";
  } else if (SUPERVISED_ONLY.test(item.reason ?? "") && !lostForGood) {
    risk = "green";
  }
  return {
    undoable,
    risk,
    deletes,
    ...(undoable ? {} : notUndoableReason ? { reason: notUndoableReason } : {}),
  };
}
