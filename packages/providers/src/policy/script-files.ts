import { readFileSync, statSync } from "node:fs";
import { type RiskAssessment, risky } from "./assessment";
import { isWin, isWritable, type PathContext, resolveAgainst } from "./paths";
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
/** Standard POSIX system binary folders, whose programs are judged by their own rules. */
const SYSTEM_BIN = /^\/(?:(?:usr\/(?:local\/)?)?s?bin|opt\/homebrew\/s?bin)\/[^/]+$/;
/** Maximum script size read from the worktree when classifying an existing script file. */
const MAX_SCRIPT_BYTES = 64 * 1024;

/** A script file operand passed to `source`, `.`, or a POSIX shell. */
export interface ScriptFileOperand {
  file: string;
  /** True for `source` / `.`, false for a shell binary (`bash <file>`). */
  sourced: boolean;
}

const isStdinOrSub = (arg: string | undefined): boolean =>
  !arg || arg === "-" || arg === "/dev/stdin" || arg === "/proc/self/fd/0" || arg.startsWith("<(");

/**
 * The script file operand `bin` runs from `args`, when `bin` is `source`, `.`, or a POSIX shell
 * invoked without `-c` / `-s`. Undefined when reading stdin, inline `-c`, or process substitution.
 */
export function shellScriptFile(bin: string, args: string[]): ScriptFileOperand | undefined {
  if (SOURCE_BINS.has(bin)) {
    const file = args[0] === "--" ? args[1] : args[0];
    return isStdinOrSub(file) ? undefined : { file: file as string, sourced: true };
  }
  if (!SHELL_BINS.has(bin)) return undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      const file = args[i + 1];
      return isStdinOrSub(file) ? undefined : { file: file as string, sourced: false };
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) || arg === "--command") return undefined;
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg)) return undefined;
    if (
      /^[-+][a-zA-Z]*[oO]$/.test(arg) ||
      arg === "--rcfile" ||
      arg === "--init-file" ||
      arg === "-C" ||
      arg === "--init-command"
    ) {
      i += 1;
      continue;
    }
    if (/^[-+]./.test(arg)) continue;
    return isStdinOrSub(arg) ? undefined : { file: arg, sourced: false };
  }
  return undefined;
}

/**
 * Verdict when a command's first token is a POSIX path (`/`, `./`, `../`, `~`) resolving outside
 * the worktree, extra roots and temp (excluding standard system binary directories).
 */
export function externalBinaryRisk(
  cmd: SimpleCommand,
  rawProg: string | undefined,
  ctx: PathContext,
): RiskAssessment | undefined {
  if (!rawProg || !/^(?:\/|\.\.?\/|~(?:\/|$))/.test(rawProg)) return undefined;
  // On Windows, a single-segment `/x` word is a cmd switch (`/d`, `/b`), not a POSIX binary path.
  if (isWin(ctx) && /^\/[^/]+$/.test(rawProg)) return undefined;
  if (unresolvedTarget(cmd, rawProg, ctx)) {
    return risky("outside_worktree", `Runs ${rawProg}, ${UNRESOLVED}`);
  }
  if (isWritable(rawProg, ctx)) return undefined;
  const abs = resolveAgainst(rawProg, ctx);
  if (SYSTEM_BIN.test(abs)) return undefined;
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
