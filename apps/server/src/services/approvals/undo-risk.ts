import type { ApprovalRisk, ItemOf } from "@codeden/contracts";
import { parseShell, type SimpleCommand } from "@codeden/providers";

type ApprovalItem = ItemOf<"approval_request">;

/**
 * CodeDen's own verdict on an approval, for the plain-words card (§11.2): whether the action
 * can be undone, and its traffic-light risk. Decided from the request itself (its command and
 * the action and reason the risk classifier gave it), never from what an agent or the utility
 * model says. Anything not recognised as reversible counts as not undoable.
 */
export interface UndoRisk {
  undoable: boolean;
  risk: ApprovalRisk;
  /** The action deletes something (`rm`, `git clean`, `find -delete`, `Remove-Item`, ...). */
  deletes: boolean;
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

type Kind = "trash" | "read_only" | "delete" | "destroy" | "other";

function classify(cmd: SimpleCommand): Kind {
  const words = programWords(cmd);
  const program = baseName(words[0] ?? "");
  const args = words.slice(1);
  if (!program) return "read_only";
  if (TRASH_TOOLS.has(program)) return "trash";
  if (program === "gio" && args[0] === "trash") return "trash";
  if (
    program === "osascript" &&
    /\bfinder\b/i.test(args.join(" ")) &&
    /\bdelete\b/i.test(args.join(" "))
  ) {
    // Finder's `delete` moves items to the Trash.
    return "trash";
  }
  if (MOVERS.has(program)) {
    const last = args.filter((a) => !a.startsWith("-")).pop();
    return last && isTrashPath(last) ? "trash" : "other";
  }
  if (DELETERS.has(program)) return "delete";
  if (DESTROYERS.has(program)) return "destroy";
  if (program === "find") {
    if (args.includes("-delete")) return "delete";
    if (args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok")) return "other";
    return "read_only";
  }
  if (program === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "clean" || sub === "rm") return "delete";
    if (sub === "branch" && args.some((a) => a === "-D" || a === "-d" || a === "--delete")) {
      return "delete";
    }
    if (sub === "push" && args.some((a) => a === "--delete" || a === "-d")) return "delete";
    if (sub && READ_ONLY_GIT.has(sub) && args.length <= 2) return "read_only";
    return "other";
  }
  return READ_ONLY.has(program) ? "read_only" : "other";
}

function flatten(cmds: SimpleCommand[]): SimpleCommand[] {
  return cmds.flatMap((c) => [c, ...c.nested.flatMap(flatten)]);
}

/**
 * Whether an approval's action can be undone and how risky it is (see {@link UndoRisk}).
 * - Undoable: a command made only of moves to the Trash and reads, with no redirect writing a
 *   file. Everything else, edits and tools included, counts as not undoable.
 * - Red: secrets access, destructive git, or a deletion that can't be undone outside the
 *   worktree. Green: it asks only because the level is Supervised and deletes nothing for good.
 *   Yellow: everything else.
 */
export function undoRisk(item: ApprovalItem): UndoRisk {
  let kinds: Kind[] = ["other"];
  if (item.command?.trim()) {
    try {
      const cmds = flatten(parseShell(item.command));
      kinds = cmds.length > 0 ? cmds.map(classify) : ["other"];
      if (cmds.some((c) => c.writes.length > 0)) kinds.push("other");
    } catch {
      kinds = ["other"];
    }
  }
  const deletes = kinds.includes("delete") || kinds.includes("destroy");
  const undoable =
    kinds.length > 0 && kinds.every((k) => k === "trash" || k === "read_only") && !deletes;
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
  return { undoable, risk, deletes };
}
