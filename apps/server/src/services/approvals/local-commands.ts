/**
 * Commands CodeDen knows change only files where they run (§11.2, #19). Inside a session's own
 * worktree, the risk classifier already checks their paths and redirects for writes outside it,
 * so the session's turn checkpoints can put back what they changed. Anything not listed here
 * (cloud and database CLIs, `docker`, `node <script>`, `npx <anything>`, `make`) is unknown and
 * counts as not undoable.
 */

/** Programs that only create, copy, move or edit files in place. */
const FILE_WRITERS = new Set([
  "mkdir",
  "touch",
  "cp",
  "mv",
  "ln",
  "sed",
  "tee",
  "chmod",
  "new-item",
  "copy-item",
  "set-content",
  "add-content",
]);

/** Git subcommands that only change the local repository and worktree. */
const LOCAL_GIT = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "restore",
  "mv",
  "init",
  "tag",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
]);

/** `git stash` subcommands that keep the stash (not `drop` or `clear`). */
const LOCAL_STASH = new Set(["push", "save", "apply", "list", "show"]);

/** Package managers whose scripts and installs are checked by subcommand. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * Package-manager subcommands and script names that build or check locally. `run` counts only
 * with one of these script names, so `pnpm run deploy` stays unknown. Installs are excluded:
 * turn checkpoints cannot restore files git ignores (`node_modules`).
 */
const LOCAL_SCRIPTS = new Set(["test", "build", "lint", "typecheck", "check", "format", "fmt"]);

/** Compilers, linters and test runners that run as their own program. */
const LOCAL_TOOLS = new Set([
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "eslint",
  "prettier",
  "biome",
  "ruff",
  "mypy",
]);

/** Subcommands of `cargo` and `go` that build or test. */
const LOCAL_BUILD_SUBCOMMANDS = new Set(["build", "test", "check", "fmt", "clippy", "vet"]);

function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

/** Whether `program args` is a command CodeDen knows stays local (see module comment). */
export function isLocalCommand(program: string, args: string[]): boolean {
  if (FILE_WRITERS.has(program) || LOCAL_TOOLS.has(program)) return true;
  const [sub, next] = positional(args);
  if (program === "git") {
    if (sub === "stash") return next === undefined || LOCAL_STASH.has(next);
    if (sub === "checkout" && args.includes("--")) return false;
    if (sub === "restore") {
      return (
        (args.includes("--staged") || args.includes("-S")) &&
        !args.includes("--worktree") &&
        !args.includes("-W")
      );
    }
    return sub !== undefined && LOCAL_GIT.has(sub);
  }
  if (PACKAGE_MANAGERS.has(program)) {
    if (args.some((a) => a === "-g" || a === "--global" || a === "--location=global")) {
      return false;
    }
    if (sub === "run" || sub === "run-script") return next !== undefined && LOCAL_SCRIPTS.has(next);
    return sub !== undefined && LOCAL_SCRIPTS.has(sub);
  }
  if (program === "cargo" || program === "go") {
    return sub !== undefined && LOCAL_BUILD_SUBCOMMANDS.has(sub);
  }
  return false;
}
