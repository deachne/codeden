import { realpathSync, statSync } from "node:fs";
import { gitTopLevel } from "../util/git-head";

/**
 * What a script's path commands print (§11.2, #153), when the paths they are given are known:
 * `$(dirname "/work/x")`, `$(cd "/work/x" && pwd)`, `$(realpath "/work/x")`. Anything else stays as
 * written.
 */

/** A path that means itself; with a space in it, only inside quotes. */
export const PLAIN = /^[\w./@+][\w ./@+-]*$/;

/** Text that changes what `dirname`, `cd` and the other path commands mean. */
export const REDEFINES =
  /\balias\b|\b(?:dirname|cd|pwd|git|realpath|readlink)\s*\(\s*\)|\bfunction\s+(?:dirname|cd|pwd|git|realpath|readlink)\b|\bhash\s+-p|\benable\s+-/;
export const PATH_COMMANDS = ["dirname", "cd", "pwd", "git", "realpath", "readlink"];

/** A word in double quotes, or a bare one. */
const WORD = String.raw`(?:"([\w./@+][\w ./@+-]*)"|([\w./@+][\w./@+-]*))`;
const QUIET = String.raw`(?:(?:&?>|1>|2>)\s*\/dev\/null\s*(?:2>&1\s*)?)?`;
const DIRNAME = new RegExp(String.raw`\$\(\s*dirname\s+(?:--\s+)?${WORD}\s*\)`, "g");
const CD_PWD = new RegExp(
  String.raw`\$\(\s*cd\s+(?:-P\s+)?(?:--\s+)?${WORD}\s*${QUIET}&&\s*pwd(?:\s+-P)?\s*\)`,
  "g",
);
const REALPATH = new RegExp(
  String.raw`\$\(\s*(?:realpath|readlink\s+-f)\s+(?:--\s+)?${WORD}\s*\)`,
  "g",
);
const TOP_LEVEL = new RegExp(
  String.raw`\$\(\s*git\s+(?:-C\s+${WORD}\s+)?rev-parse\s+--show-toplevel\s*${QUIET}(\|\|\s*[^();&|]*)?\)`,
  "g",
);

/** A fallback that prints where the shell is. */
const HERE = /^\|\|\s*(?:pwd|echo\s+"?(?:\.|\$PWD)"?)\s*$/;

/** What `dirname` prints. */
export function dirname(file: string): string {
  if (!file.includes("/")) return ".";
  const cut = file.replace(/\/+$/, "").replace(/\/+[^/]*$/, "");
  return cut === "" ? "/" : cut;
}

/**
 * `word` with what its path commands print filled in. `here`: where the shell is, which a relative
 * path is below; undefined when that isn't known. `git`: the repository is the folder's own.
 */
export function printedPaths(word: string, here: string | undefined, git: boolean): string {
  if (!word.includes("$(")) return word;
  const absolute = (path: string): string | undefined =>
    path.startsWith("/") ? path : here === undefined ? undefined : `${here}/${path}`;
  let text = word;
  // `$(dirname "$(dirname "$(realpath x)")")`: the innermost is known first.
  for (let round = 0; round < 6; round += 1) {
    const next = text
      .replace(DIRNAME, (_, a?: string, b?: string) => dirname(a ?? b ?? ""))
      .replace(CD_PWD, (all, a?: string, b?: string) => onDisk(absolute(a ?? b ?? "")) ?? all)
      .replace(REALPATH, (all, a?: string, b?: string) => realOf(absolute(a ?? b ?? "")) ?? all)
      .replace(TOP_LEVEL, (all, a?: string, b?: string, or?: string) => {
        const dir = git ? absolute(a ?? b ?? ".") : undefined;
        if (dir === undefined) return all;
        const top = gitTopLevel(dir) ?? (or && HERE.test(or) ? here : undefined);
        return top !== undefined && PLAIN.test(top) ? top : all;
      });
    if (next === text) break;
    text = next;
  }
  return text;
}

/** A folder that is there, without `.` and `..`: a `cd` that fails leaves nothing to print. */
function onDisk(dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  try {
    const path = normal(dir);
    return PLAIN.test(path) && statSync(path).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

function realOf(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try {
    const path = realpathSync(file);
    return PLAIN.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** An absolute path as `cd` and `pwd` give it. */
function normal(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "" && part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
}
