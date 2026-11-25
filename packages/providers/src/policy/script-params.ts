/**
 * The default values a script gives its settings (§11.2, #153): `DIR="${DATA_DIR:-$ROOT/data}"`.
 * The agent's environment is known, so a setting that isn't in it has its default, unless something
 * on the command line may set it: then it stays as written, a path only known when it runs.
 */

/** What a script's settings may come from. */
export interface ScriptInput {
  env: Readonly<Record<string, string | undefined>>;
  /** The command line and the other scripts it runs, any of which may set a variable. */
  texts: readonly string[];
}

/** `${NAME:-x}`, `${NAME:=x}`, also without the colon. */
const DEFAULT = /\$\{([A-Za-z_]\w*):?[-=]((?:[^{}`]|\$\{[A-Za-z_]\w*\})*)\}/g;
/** What may set any variable: a file or a string run in this shell, or a name built as it runs. */
const SETS_ANY =
  /(?:^|[;&|\s\\])(?:source|\.|eval)\s|\b(?:read|export|declare|typeset|local|readonly|mapfile|readarray|getopts)\s[^\n;&|]*\$|\bprintf\s+-v/m;
/** What may set one on the command line, its name perhaps pieced together with quotes. */
const SETS_OUTSIDE =
  /\b(?:env|export|declare|typeset|readonly|allexport|source|eval|read|printf)\b|\bset\s+-\w*a|(?:^|[;&|\s])\.\s|\\|\w["']+\w|["']{2}/m;
/** Names the shell or the system sets, or that other rules read. */
const SYSTEM =
  /^(?:HOME|PWD|OLDPWD|PATH|TMPDIR|TEMP|TMP|USER|LOGNAME|SHELL|BASH\w*|IFS|RANDOM|SECONDS|CODEDEN\w*|CDPATH|GIT\w*|XDG\w*|HOSTNAME|UID|EUID|PPID|LINENO|FUNCNAME|REPLY|OPTARG|OPTIND)$/;

/** How to fill in the defaults in a word of the script `text`. */
export function defaultsOf(text: string, input: ScriptInput): (word: string) => string {
  const setsAny = SETS_ANY.test(text) || input.texts.some((t) => SETS_OUTSIDE.test(t));
  const code = text.replace(/^\s*#.*$/gm, "");
  const free = new Map<string, boolean>();
  const isFree = (name: string): boolean => {
    let known = free.get(name);
    if (known === undefined) {
      known = !setsAny && !SYSTEM.test(name) && onlyDefaulted(name, code, input);
      free.set(name, known);
    }
    return known;
  };
  return (word) =>
    word.replace(DEFAULT, (all, name: string, other: string) => (isFree(name) ? other : all));
}

/**
 * True when `name` isn't set in the agent's environment or anywhere on the command line, and the
 * script only expands it or gives it its own default (`X="${X:-x}"`).
 */
function onlyDefaulted(name: string, code: string, { env, texts }: ScriptInput): boolean {
  if (env[name] !== undefined) return false;
  const mention = new RegExp(`(?<!\\w)${name}(?!\\w)`);
  if (texts.some((text) => mention.test(text))) return false;
  const uses = new RegExp(
    `(?<![\\w$])${name}="?(?=\\$\\{${name}:?[-=])|\\$\\{?${name}(?!\\w)`,
    "g",
  );
  return !mention.test(code.replace(uses, ""));
}
