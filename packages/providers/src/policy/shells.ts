/** Shells that run POSIX-like command lines: an inline `-c` script, a script file or their input. */
export const SHELL_BINS: ReadonlySet<string> = new Set([
  ...["sh", "bash", "rbash", "dash", "ash", "zsh", "rzsh", "fish", "yash", "posh", "csh", "tcsh"],
  ...["ksh", "rksh", "ksh93", "mksh", "lksh", "pdksh"],
]);

/** The shell a variable every shell sets names: `$SHELL`, `"${BASH}"`, `${SHELL:-/bin/sh}`. */
const SHELL_VARIABLE = /^\$(?:SHELL|BASH|\{(?:SHELL|BASH)(?::?-(?:\/(?:usr\/)?bin\/)?[a-z]+)?\})$/;

/** The word for a program, with `bash` in place of a variable that names a shell. */
export const shellNamed = (word: string): string | undefined =>
  SHELL_VARIABLE.test(word) ? "bash" : undefined;

/** Bash takes its long options after one dash too (`-norc`, `-rcfile f`). */
const LONG =
  /^-(?=(?:rcfile|init-file|norc|noprofile|noediting|login|posix|restricted|verbose|debugger|dump-strings|dump-po-strings|help|version)$)/;

/** `arg` with the dashes its name is listed with. */
export const longOption = (arg: string): string => arg.replace(LONG, "--");

/** The start-up file bash is given (`bash --rcfile f`), which it runs before anything else. */
export function startupFile(bin: string, args: readonly string[]): string | undefined {
  if (!SHELL_BINS.has(bin)) return undefined;
  let file: string | undefined;
  // Long options come first.
  for (let i = 0; i < args.length; i += 1) {
    const option = longOption(args[i] as string);
    if (!/^--./.test(option)) break;
    if (option === "--rcfile" || option === "--init-file") file = args[++i];
  }
  return file;
}
