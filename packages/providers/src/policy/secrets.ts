import { isSecretPath } from "./paths";
import { parseSearch, SEARCHES, type SearchWord } from "./search-words";
import type { WordPaths } from "./shell";

/**
 * Secrets rules of the risk classifier (§11.2): which words of a command read a credentials
 * file (`./env-dumps` has the commands that dump the environment). Writing a secrets file inside
 * the worktree is not access (`cp .env.example .env`); reading one is.
 */

/**
 * The argument as a path, or undefined when it can't be one: inline code, multi-line text
 * or anything with shell or code punctuation (`selected={row.key`) is not a file name. A
 * variable in braces (`${HOME}/.env`, PowerShell's `${env:USERPROFILE}\.aws\credentials`) is a
 * path, and so is an option's value: `--file=x`, or PowerShell's colon-bound `-Path:x` and
 * `-LiteralPath:x`.
 */
export function asPath(arg: string): string | undefined {
  const value = arg.replace(/^-+[a-z-]*=/i, "").replace(/^-[a-z][a-z-]*:(?=.)/i, "");
  if (!value || /[\n\r{}()<>|;=`]/.test(value.replace(/\$\{(?:env:)?\w+\}/gi, ""))) {
    return undefined;
  }
  return value;
}

/** Commands whose words are data or only checked for existence (`echo .env >> .gitignore`). */
export const DATA = new Set(["echo", "printf", "write-output", "write-host", "test", "[", "[["]);
/** Commands that list or describe files without reading them (`ls certs/*.pem`). */
export const LISTS = new Set([
  "ls",
  "dir",
  "get-childitem",
  "gci",
  "find",
  "fd",
  "tree",
  "stat",
  "du",
  "test-path",
]);

/** `find -exec cat {}` and `fd -x cat`: a listing that runs a command on what it finds. */
export function runsOnFound(bin: string, args: readonly string[]): boolean {
  return (
    (bin === "find" || bin === "fd") &&
    args.some((a) => /^-(exec|execdir|ok|okdir|x|X|-exec|-exec-batch)$/.test(a))
  );
}

/**
 * The first argument that reads a credentials file, if any. `written` are the paths the command
 * writes (a copy's destination), which classifyWrite judges instead. `isSecret` decides which
 * paths count (default: secrets files by name). `paths` gives what a word may stand for (each
 * element of a PowerShell list, `shell.wordPaths`). A search's patterns are skipped whole, list
 * elements included: the tool searches for them, not in them.
 */
export function secretArgument(
  bin: string,
  args: string[],
  written: readonly string[] = [],
  isSecret: (path: string) => boolean = isSecretPath,
  paths: WordPaths = (word, from) => [word.slice(from)],
): string | undefined {
  if (DATA.has(bin)) return undefined;
  if (LISTS.has(bin) && !runsOnFound(bin, args)) return undefined;
  const words: Pick<SearchWord, "text" | "arg" | "from" | "pattern">[] = SEARCHES.has(bin)
    ? parseSearch(bin, args)
    : args.map((text, arg) => ({ text, arg, from: 0, pattern: false }));
  const found = words.find((w) => {
    if (w.pattern || written.includes(w.text)) return false;
    const candidates = w.arg >= 0 ? paths(args[w.arg] as string, w.from) : [w.text];
    return candidates.some((word) =>
      braceAlternatives(word).some((alt) =>
        [alt, uploaded(alt)].some((form) => {
          const value = asPath(form);
          return value !== undefined && isSecret(value);
        }),
      ),
    );
  });
  return found?.text;
}

/**
 * The file an upload word names (`curl -F file=@x`, `--data-binary @x`, `--data=@x`): the word
 * without its option, field name and `@`. Unchanged when it has no `@`.
 */
function uploaded(word: string): string {
  return word.replace(/^(-+[a-z-]*=)?([\w.-]*=)?@(?=.)/i, "");
}

/** The most words one argument's brace expansion is followed to. */
const MAX_ALTERNATIVES = 64;

/** The most groups it fills in; a word with more makes more words than a shell can hold. */
const MAX_GROUPS = 2000;

/** The first `{a,b}` group in `word` with no braces inside it, looked for from `from`. */
function braceGroup(word: string, from: number) {
  // Each `{` is read only up to the next brace, so this takes time in proportion to the word.
  const groups = /\{([^{}]*)\}/g;
  groups.lastIndex = from;
  for (let m = groups.exec(word); m; m = groups.exec(word)) {
    const body = m[1] as string;
    if (!body.includes(",")) continue;
    return { start: m.index, end: groups.lastIndex, parts: body.split(",", MAX_ALTERNATIVES) };
  }
  return undefined;
}

/**
 * The words a shell's brace expansion makes of `word` (`~/.ssh/{id_rsa,x}` -> `~/.ssh/id_rsa`,
 * `~/.ssh/x`), capped; just `word` when it has no `{a,b}` group. Groups are filled in depth first
 * and only until there are enough words, so many groups don't multiply (#153).
 */
export function braceAlternatives(word: string): string[] {
  const out: string[] = [];
  // Words still to fill in, the next one last; built only when taken, as most may never be.
  const left = [{ text: () => word, from: 0 }];
  for (let done = 0; out.length < MAX_ALTERNATIVES && done < MAX_GROUPS; done += 1) {
    const next = left.pop();
    if (!next) break;
    const text = next.text();
    const group = braceGroup(text, next.from);
    if (!group) {
      out.push(text);
      continue;
    }
    const before = text.slice(0, group.start);
    const after = text.slice(group.end);
    // Filling it in may complete the group right around it; no earlier one changes.
    const from = Math.max(0, before.lastIndexOf("{"));
    for (const part of group.parts.reverse()) {
      left.push({ text: () => before + part + after, from });
    }
  }
  return out.length > 0 ? out : [word];
}

/** Files a tool writes through its own options (`openssl req -keyout key.pem -out cert.pem`). */
export function toolOutputs(bin: string, args: string[]): string[] {
  if (bin !== "openssl" && bin !== "ssh-keygen") return [];
  const flags = bin === "openssl" ? ["-out", "-keyout"] : ["-f"];
  return args.flatMap((a, i) => (flags.includes(a) && args[i + 1] ? [args[i + 1] as string] : []));
}
