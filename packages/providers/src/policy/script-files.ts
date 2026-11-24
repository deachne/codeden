import { readFileSync, statSync } from "node:fs";
import { type RiskAssessment, risky } from "./assessment";
import {
  homeOf,
  isInWorkspace,
  isWin,
  isWritable,
  type PathContext,
  resolveAgainst,
} from "./paths";
import type { Work } from "./script-work";
import type { SimpleCommand } from "./shell";
import { UNRESOLVED, unresolvedTarget } from "./variables";

/**
 * Script files and external binaries (§11.2, #153):
 * - `source`, `.`, and POSIX shells (`sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `ash`, `fish`)
 *   running a script file operand (including `bash < file`, which `./shell` keeps as a word);
 * - invoking a command directly by path (`/`, `./`, `../`, `~`) outside writable roots (also
 *   covers `find -exec /outside/x` and `rg --pre /outside/pre.sh`).
 */

const SOURCE_BINS = new Set(["source", "."]);
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
/**
 * Folders that installed tools live in, whose programs are judged by their own rules. Writing there
 * asks, so a program an agent could plant is never in one.
 */
const SYSTEM_BIN =
  /^\/(?:(?:usr\/(?:local\/(?:go\/)?)?)?s?bin\/[^/]+|opt\/homebrew\/(?:opt\/[^/]+\/)?s?bin\/[^/]+|usr\/libexec\/.+|Applications\/.+)$/;
/** The same in the home folder. */
const HOME_BIN = /^\/\.(?:local|cargo)\/bin\/[^/]+$/;
/** Where nvm and virtualenvs install the file that sets a shell up for them. */
const HOME_SETUP =
  /^\/\.(?:nvm\/(?:nvm\.sh|bash_completion)|(?:virtualenvs|venvs)\/[^/]+\/bin\/activate|venv\/bin\/activate)$/;
const SYSTEM_SETUP = /^\/(?:opt\/homebrew|usr\/local)\/opt\/nvm\/nvm\.sh$/;
/** A virtualenv in the project, by its usual names. */
const PROJECT_VENV = /(?:^|\/)\.?v?env\/bin\/activate$/;
/** A program given as a path: rooted, relative, or below a home folder. */
const PROGRAM_PATH = /^(?:\/|[\w.@+-]+\/|~[\w.+-]*(?:\/|$)|\$HOME(?:\/|$)|\$\{HOME\b)/;
/** Another user's home folder (`~me/x`), or the shell's folder before (`~-/x`). */
export const OTHER_HOME = /^~[^/]/;
/** Shell options that take the next word, and fish's. */
const VALUED = new Set(["--rcfile", "--init-file", "--init-command"]);
const FISH_VALUED = /^-[CdDfop]$/;
/** Maximum script size read from the worktree when classifying an existing script file. */
const MAX_SCRIPT_BYTES = 64 * 1024;

/** A script file operand passed to `source`, `.`, or a POSIX shell. */
export interface ScriptFileOperand {
  file: string;
  /** True for `source` / `.`, false for a shell binary (`bash <file>`). */
  sourced: boolean;
}

const isStdinOrSub = (arg: string | undefined): boolean =>
  !arg ||
  /^(?:-|\/dev\/stdin|\/dev\/null|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(arg) ||
  arg.startsWith("<(");

/** The part of `abs` below the home folder, starting with `/`; empty when it isn't there. */
function belowHome(abs: string, ctx: PathContext): string {
  const home = homeOf(ctx).replace(/\/+$/, "");
  return home && abs.startsWith(`${home}/`) ? abs.slice(home.length) : "";
}

/** True when `file` sets a shell up for nvm or a virtualenv, where those are normally installed. */
export function isSetupFile(file: string, ctx: PathContext): boolean {
  if (isWin(ctx)) return false;
  const abs = resolveAgainst(file, ctx);
  return SYSTEM_SETUP.test(abs) || HOME_SETUP.test(belowHome(abs, ctx));
}

/** True when `file` is where a virtualenv of the project is activated from. */
export const isProjectVenv = (file: string, ctx: PathContext): boolean =>
  isInWorkspace(file, ctx) && PROJECT_VENV.test(resolveAgainst(file, ctx));

/**
 * The script file operand `bin` runs from `args`, when `bin` is `source`, `.`, or a POSIX shell
 * invoked without `-c`, or the file it reads its commands from (`inputFiles`: `< file`, also among
 * `given`; with `-s` too). Undefined for other input, inline `-c`, process substitution, or a shell that only
 * checks the syntax (`bash -n`).
 */
export function shellScriptFile(
  bin: string,
  given: string[],
  inputFiles: readonly string[] = [],
): ScriptFileOperand | undefined {
  const sourced = SOURCE_BINS.has(bin);
  if (!sourced && !SHELL_BINS.has(bin)) return undefined;
  const args = [...given];
  for (const file of inputFiles) {
    const at = args.lastIndexOf(file);
    if (at >= 0) args.splice(at, 1);
  }
  const from = (file: string | undefined): ScriptFileOperand | undefined =>
    isStdinOrSub(file) ? undefined : { file: file as string, sourced };
  // A shell told to read its input runs the file its input comes from.
  const operand = (file: string | undefined): ScriptFileOperand | undefined =>
    from(file) ??
    (file === "/dev/null" || file?.startsWith("<(") ? undefined : from(inputFiles.at(-1)));
  if (sourced) return args.length > 0 ? operand(args[0] === "--" ? args[1] : args[0]) : undefined;

  let noexec = false;
  let interactive = false;
  let stdin = false;
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i] as string;
    // A lone `-` ends the options too.
    if (arg === "--" || arg === "-") {
      i += 1;
      break;
    }
    if (arg === "--command") return undefined;
    if (VALUED.has(arg) || (bin === "fish" && FISH_VALUED.test(arg))) {
      i += 1;
      continue;
    }
    const cluster = /^([-+])([a-zA-Z]+)$/.exec(arg);
    if (cluster) {
      // zsh reads an option's name right after `o` (`-oerrexit`); other shells, from the next words.
      const letters = cluster[2]?.replace(bin === "zsh" ? /(?<=[oO]).*/ : /$^/, "") ?? "";
      const on = cluster[1] === "-";
      if (on && letters.includes("c")) return undefined;
      if (on && letters.includes("s")) stdin = true;
      if (letters.includes("n")) noexec = on;
      // An interactive shell runs the script all the same.
      if (letters.includes("i")) interactive = true;
      const named = letters.match(/[oO]/g)?.length ?? 0;
      if (bin !== "zsh" || letters === cluster[2]) i += named;
    } else if (!/^[-+]./.test(arg)) break;
  }
  if (noexec && !interactive) return undefined;
  return operand(stdin ? undefined : args[i]);
}

/**
 * Verdict when a command's first token is a POSIX path (`/`, `./`, `x/`, `../`, `~`, `$HOME`)
 * resolving outside the worktree, extra roots and temp (excluding folders of installed tools).
 */
export function externalBinaryRisk(
  cmd: SimpleCommand,
  rawProg: string | undefined,
  ctx: PathContext,
): RiskAssessment | undefined {
  if (!rawProg || !PROGRAM_PATH.test(rawProg)) return undefined;
  // On Windows, a single-segment `/x` word is a cmd switch (`/d`, `/b`), not a POSIX binary path.
  if (isWin(ctx) && /^\/[^/]+$/.test(rawProg)) return undefined;
  if (unresolvedTarget(cmd, rawProg, ctx)) {
    return risky("outside_worktree", `Runs ${rawProg}, ${UNRESOLVED}`);
  }
  if (isWritable(rawProg, ctx) && !OTHER_HOME.test(rawProg)) return undefined;
  const abs = resolveAgainst(rawProg, ctx);
  if (SYSTEM_BIN.test(abs) || HOME_BIN.test(belowHome(abs, ctx))) return undefined;
  return risky("outside_worktree", `Runs ${rawProg}, outside the worktree`);
}

/** Result of trying to read an existing regular script file inside a writable root. */
export type LocalScript =
  | { kind: "read"; text: string }
  | { kind: "too_large" }
  | { kind: "missing" };

/** Read an existing regular script file (bounded to 64 KiB) so its commands can be classified. */
export function readLocalScript(file: string, ctx: PathContext, work?: Work): LocalScript {
  const abs = resolveAgainst(file, ctx);
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return { kind: "missing" };
    if (stat.size > MAX_SCRIPT_BYTES) return { kind: "too_large" };
    if (work?.script(stat.size) === false) return { kind: "too_large" };
    return { kind: "read", text: readFileSync(abs, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}
