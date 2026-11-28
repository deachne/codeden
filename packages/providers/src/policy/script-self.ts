import type { WithFunctions } from "./blocks";
import { CD, unwrap } from "./command-words";
import { isUnknownDir, isWin, type PathContext, resolveAgainst } from "./paths";
import { defaultsOf, type ScriptInput } from "./script-params";
import { dirname, PATH_COMMANDS, PLAIN, printedPaths, REDEFINES } from "./script-paths";
import type { SimpleCommand } from "./shell";

/**
 * A script that names its own folder (§11.2, #153): `cd "$(dirname "$0")/.."`,
 * `ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`. The file a command runs is known, so
 * what these give is too: they are filled in as the shell would, and what the script does there is
 * judged like any other path. A script that could change what they mean keeps them as written,
 * which counts as a path only known when it runs.
 */

/** A script file being run: the word naming it, and what runs it (`bash`, `source`, `zsh`, ...). */
export interface RunFile extends ScriptInput {
  file: string;
  bin: string;
}

/** What a script sees as itself. Undefined: not known, left as written. */
interface Self {
  zero: string | undefined;
  source: string | undefined;
  /** `$0` names the function inside one (zsh). */
  zeroInFunctions: boolean;
  /** The folder it starts in; undefined when that isn't known. */
  here: string | undefined;
  /** The repository is the one its folder is in. */
  git: boolean;
  defaults: (word: string) => string;
}

/** Where the rewriting stands: a relative path given as absolute needs the folder it started in. */
interface State {
  /** An earlier command may have changed the folder. */
  moved: boolean;
  /** Functions and loops open here, which may run again later, after a `cd` further down. */
  depth: number;
}

/** Text that changes what `$0` or `BASH_SOURCE` mean. */
const RENAMES =
  /\bBASH_ARGV0\b|\bBASH_SOURCE(?:\[[^\]]*\])?\+?=|\b(?:read|unset|declare|typeset|local|export|printf|mapfile|readarray)\s[^\n;]{0,200}\bBASH_SOURCE\b(?!\[|\}|")/;

const SOURCE = String.raw`\$BASH_SOURCE(?![\w[])|\$\{BASH_SOURCE(?:\[0\])?\}`;
const EITHER = String.raw`\$\{BASH_SOURCE(?:\[0\])?:-\$0\}`;
const ZERO = String.raw`\$0|\$\{0\}`;
/** One way to name the script: `$0`, `${BASH_SOURCE[0]}`, `${BASH_SOURCE[0]:-$0}`. */
const ANY = `(?:${EITHER}|${SOURCE}|${ZERO})`;
/** The same as a bare argument of a substitution, where its spaces would split it. */
const ARGUMENT = new RegExp(String.raw`\$\(\s*\w+(?:\s+-\S+)*\s+${ANY}\s*\)`);
const DIRNAME = new RegExp(
  String.raw`\$\(\s*dirname\s+(?:--\s+)?(?:"(${ANY})"|(${ANY}))\s*\)`,
  "g",
);
const CUT = /\$\{(0|BASH_SOURCE(?:\[0\])?)%\/\*\}/g;
const BARE = new RegExp(ANY, "g");
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** Each way the script may see itself: `BASH_SOURCE` is empty in shells other than bash. */
function selves(text: string, run: RunFile, ctx: PathContext): Self[] {
  const { file, bin } = run;
  if (isWin(ctx) || bin === "fish") return [];
  const name = /^[~$]/.test(file) ? resolveAgainst(file, ctx) : file;
  if (!PLAIN.test(name)) return [];
  const sourced = bin === "source" || bin === ".";
  const self = {
    zero: sourced ? undefined : name,
    zeroInFunctions: bin !== "zsh",
    here: isUnknownDir(ctx.dir) ? undefined : resolveAgainst(".", ctx),
    git: !ctx.gitEnv && (ctx.platform ?? process.platform) !== "win32",
    defaults: defaultsOf(text, run),
  };
  const bash = { ...self, source: name };
  return bin === "bash" ? [bash] : [bash, { ...self, source: "" }];
}

/** True when the path commands a script uses mean what they always do. */
export const keepsMeaning = (text: string, ctx: WithFunctions): boolean =>
  !REDEFINES.test(text) &&
  !RENAMES.test(text) &&
  !PATH_COMMANDS.some((name) => ctx.functions?.has(name));

/**
 * The ways to rewrite the commands of the script `text` run as `run`, each to be judged: one that
 * changes nothing when it doesn't name itself, or may change what that means (`keepsMeaning`).
 */
export function selfReadings(
  text: string,
  run: RunFile,
  ctx: PathContext & WithFunctions,
): Array<(list: SimpleCommand[]) => SimpleCommand[]> {
  const known = keepsMeaning(text, ctx) ? selves(text, run, ctx) : [];
  if (known.length === 0) return [(list) => list];
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
  const bare = new Set(cmd.bare);
  const fill = (word: string): string => {
    if (!cmd.vars?.has(word)) return word;
    const text = filled(word, self, state);
    // A name with a space in it, outside quotes, is several words: left as written.
    const splits = (cmd.bare?.has(word) && !ASSIGNMENT.test(word)) || ARGUMENT.test(word);
    if (
      splits &&
      text !== word &&
      [self.zero, self.source, self.here].some((s) => s?.includes(" "))
    ) {
      vars.add(word);
      return word;
    }
    if (/[$`]/.test(text)) vars.add(text);
    if (cmd.quoted?.has(word)) quoted.add(text);
    if (cmd.bare?.has(word)) bare.add(text);
    return text;
  };
  const out: SimpleCommand = { ...cmd, words: cmd.words.map(fill), writes: cmd.writes.map(fill) };
  if (cmd.input) out.input = cmd.input.map(fill);
  if (cmd.inputFiles) out.inputFiles = cmd.inputFiles.map(fill);
  return { ...out, vars, quoted, bare };
}

function filled(word: string, self: Self, state: State): string {
  const zero = state.depth > 0 && !self.zeroInFunctions ? undefined : self.zero;
  const value = (ref: string): string | undefined => {
    if (!ref.includes("BASH_SOURCE")) return zero;
    return ref.includes(":-") ? self.source || zero : self.source;
  };
  const fixed = !state.moved && state.depth === 0;
  const text = word
    .replace(DIRNAME, (all, a?: string, b?: string) => {
      const file = value(a ?? b ?? "");
      return file === undefined ? all : dirname(file);
    })
    .replace(CUT, (all, ref: string) => value(ref)?.replace(/\/[^/]*$/, "") ?? all)
    .replace(BARE, (ref) => value(ref) ?? ref);
  const known = printedPaths(text, fixed ? self.here : undefined, self.git && fixed);
  return self.defaults(known);
}
