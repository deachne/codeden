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
    return last && isTrashPath(last) ? "trash" : "local";
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
    return isLocalCommand(program, args) ? "local" : "other";
  }
  if (READ_ONLY.has(program)) return "read_only";
  return isLocalCommand(program, args) ? "local" : "other";
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
 *   put it back. Unknown programs, tools, network and anything outside the worktree count as
 *   not undoable.
 * - Red: secrets access, destructive git, or a deletion that can't be undone outside the
 *   worktree. Green: it asks only because the level is Supervised and deletes nothing for good.
 *   Yellow: everything else.
 */
export function undoRisk(item: ApprovalItem, context: UndoRiskContext = {}): UndoRisk {
  let kinds: Kind[] = ["other"];
  let writes = false;
  if (item.command?.trim()) {
    try {
      const cmds = flatten(parseShell(item.command));
      kinds = cmds.length > 0 ? cmds.map(classify) : ["other"];
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
  return { undoable, risk, deletes };
}
