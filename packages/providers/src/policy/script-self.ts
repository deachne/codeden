import { statSync } from "node:fs";
import type { WithFunctions } from "./blocks";
import { CD, unwrap } from "./command-words";
import { isWin, type PathContext, resolveAgainst } from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * A script that names its own folder (§11.2, #153): `cd "$(dirname "$0")/.."`,
 * `ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`. The file a command runs is known, so
 * what these give is too: they are filled in as the shell would, and what the script does there is
 * judged like any other path. A script that could change what they mean keeps them as written,
 * which counts as a path only known when it runs.
 */

/** A script file being run: the word naming it, and what runs it (`bash`, `source`, `zsh`, ...). */
export interface RunFile {
  file: string;
  bin: string;
}

/** What a script sees as itself. Undefined: not known, left as written. */
interface Self {
  zero: string | undefined;
  source: string | undefined;
  /** `$0` names the function inside one (zsh). */
  zeroInFunctions: boolean;
  ctx: PathContext;
}

/** Where the rewriting stands: a relative path given as absolute needs the folder it started in. */
interface State {
  /** An earlier command may have changed the folder. */
  moved: boolean;
  /** Functions and loops open here, which may run again later, after a `cd` further down. */
  depth: number;
}

/** A name that means itself in any word and any shell. */
const PLAIN = /^[\w./@+][\w./@+-]*$/;
/** Text that changes what `$0`, `BASH_SOURCE`, `dirname`, `cd` or `pwd` mean. */
const REDEFINES =
  /\bBASH_ARGV0\b|\bBASH_SOURCE(?:\[[^\]]*\])?\+?=|\b(?:read|unset|declare|typeset|local|export|printf|mapfile|readarray)\s[^\n;]{0,200}\bBASH_SOURCE\b(?!\[|\}|")|\balias\b|\b(?:dirname|cd|pwd)\s*\(|\bfunction\s+(?:dirname|cd|pwd)\b/;

const SOURCE = String.raw`\$BASH_SOURCE(?![\w[])|\$\{BASH_SOURCE(?:\[0\])?\}`;
const EITHER = String.raw`\$\{BASH_SOURCE(?:\[0\])?:-\$0\}`;
const ZERO = String.raw`\$0|\$\{0\}`;
/** One way to name the script: `$0`, `${BASH_SOURCE[0]}`, `${BASH_SOURCE[0]:-$0}`. */
const ANY = `(?:${EITHER}|${SOURCE}|${ZERO})`;
const DIRNAME = new RegExp(
  String.raw`\$\(\s*dirname\s+(?:--\s+)?(?:"(${ANY})"|(${ANY}))\s*\)`,
  "g",
);
const CUT = /\$\{(0|BASH_SOURCE(?:\[0\])?)%\/\*\}/g;
const BARE = new RegExp(ANY, "g");
const CD_PWD =
  /\$\(\s*cd\s+(?:-P\s+)?(?:--\s+)?(?:"([\w./@+-]+)"|([\w./@+-]+))\s*(?:(?:&?>|1>)\s*\/dev\/null\s*(?:2>&1\s*)?)?&&\s*pwd(?:\s+-P)?\s*\)/g;

/** What `dirname` prints. */
function dirname(file: string): string {
  if (!file.includes("/")) return ".";
  const cut = file.replace(/\/+$/, "").replace(/\/+[^/]*$/, "");
  return cut === "" ? "/" : cut;
}

/** Each way the script may see itself: `BASH_SOURCE` is empty in shells other than bash. */
function selves({ file, bin }: RunFile, ctx: PathContext): Self[] {
  if (isWin(ctx) || bin === "fish") return [];
  const name = /^[~$]/.test(file) ? resolveAgainst(file, ctx) : file;
  if (!PLAIN.test(name)) return [];
  const sourced = bin === "source" || bin === ".";
  const self = {
    zero: sourced ? undefined : name,
    zeroInFunctions: bin !== "zsh",
    ctx,
  };
  const bash = { ...self, source: name };
  return bin === "bash" ? [bash] : [bash, { ...self, source: "" }];
}

/**
 * The ways to rewrite the commands of the script `text` run as `run`, each to be judged: one that
 * changes nothing when it doesn't name itself, or may change what that means.
 */
export function selfReadings(
  text: string,
  run: RunFile,
  ctx: PathContext & WithFunctions,
): Array<(list: SimpleCommand[]) => SimpleCommand[]> {
  const asWritten = [(list: SimpleCommand[]) => list];
  if (!/\$\{?0|BASH_SOURCE/.test(text) || REDEFINES.test(text)) return asWritten;
  if (["dirname", "cd", "pwd"].some((name) => ctx.functions?.has(name))) return asWritten;
  const known = selves(run, ctx);
  if (known.length === 0) return asWritten;
  const ways = /BASH_SOURCE/.test(text) ? known : known.slice(0, 1);
  return ways.map((self) => (list) => place(list, self, { moved: false, depth: 0 }));
}

const OPENS = new Set(["for", "while", "until", "select", "{"]);
const MOVES = new Set([...CD, "popd", "eval", "source", "trap", "exec"]);

function place(list: SimpleCommand[], self: Self, state: State): SimpleCommand[] {
  return list.map((cmd) => {
    const [first = "", second] = cmd.words;
    const header = /\(\)\{?$/.test(first) || second === "()" || first === "function";
    const opened = cmd.words.filter((w) => OPENS.has(w) || w.endsWith("(){")).length;
    // A function whose body isn't in this command never counts as closed.
    state.depth += header ? Math.max(1, opened) : opened;
    const out = rewrite(cmd, self, state);
    out.nested = cmd.nested.map((inner) => place(inner, self, { ...state }));
    if (first === "done" || first === "}") state.depth = Math.max(0, state.depth - 1);
    const { tokens } = unwrap(cmd.words);
    const program = tokens[0] ?? "";
    state.moved ||= program === "." || /^[$`]/.test(program) || cmd.words.some((w) => MOVES.has(w));
    return out;
  });
}

/** `cmd` with its own file filled in where its words expand it. */
function rewrite(cmd: SimpleCommand, self: Self, state: State): SimpleCommand {
  if (!cmd.vars?.size) return { ...cmd };
  const vars = new Set<string>();
  const quoted = new Set(cmd.quoted);
  const fill = (word: string): string => {
    if (!cmd.vars?.has(word)) return word;
    const text = filled(word, self, state);
    if (/[$`]/.test(text)) vars.add(text);
    if (cmd.quoted?.has(word)) quoted.add(text);
    return text;
  };
  const out: SimpleCommand = { ...cmd, words: cmd.words.map(fill), writes: cmd.writes.map(fill) };
  if (cmd.input) out.input = cmd.input.map(fill);
  if (cmd.inputFiles) out.inputFiles = cmd.inputFiles.map(fill);
  return { ...out, vars, quoted };
}

function filled(word: string, self: Self, state: State): string {
  const zero = state.depth > 0 && !self.zeroInFunctions ? undefined : self.zero;
  const value = (ref: string): string | undefined => {
    if (!ref.includes("BASH_SOURCE")) return zero;
    return ref.includes(":-") ? self.source || zero : self.source;
  };
  const text = word
    .replace(DIRNAME, (all, a?: string, b?: string) => {
      const file = value(a ?? b ?? "");
      return file === undefined ? all : dirname(file);
    })
    .replace(CUT, (all, ref: string) => value(ref)?.replace(/\/[^/]*$/, "") ?? all)
    .replace(BARE, (ref) => value(ref) ?? ref);
  return text.replace(CD_PWD, (all, a?: string, b?: string) => {
    const dir = a ?? b ?? "";
    const fixed = dir.startsWith("/") || (!state.moved && state.depth === 0);
    const abs = resolveAgainst(dir, self.ctx);
    return fixed && PLAIN.test(abs) && isFolder(abs) ? abs : all;
  });
}

/** A `cd` that fails would leave the variable empty, so the folder must be there. */
function isFolder(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
