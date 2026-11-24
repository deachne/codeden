import { type RiskAssessment, risky } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isWritable } from "./paths";
import { readLocalScript, shellScriptFile } from "./script-files";
import { TOO_LARGE } from "./script-work";
import type { SimpleCommand } from "./shell";
import { shellReadings } from "./shell-readings";
import type { RiskContext } from "./targets";
import { UNRESOLVED, unresolvedTarget } from "./variables";

/**
 * The verdicts on the script file `cmd` runs (`./script-files`), if any: one outside the worktree
 * asks, and one inside it is read and its commands judged by `classify`, like an inline script's.
 * `follow`: the script isn't nested deeper than is followed. Where the work for the command line
 * runs out (`./script-work`), or a script can't be parsed, it asks.
 */
export function scriptFileRisks(
  cmd: SimpleCommand,
  ctx: RiskContext,
  follow: boolean,
  classify: (list: SimpleCommand[]) => RiskAssessment,
): RiskAssessment[] {
  const { tokens } = unwrap(cmd.words);
  const script = shellScriptFile(binName(tokens[0]), tokens.slice(1));
  if (!script) return [];
  const { file } = script;
  if (unresolvedTarget(cmd, file, ctx)) {
    return [risky("outside_worktree", `Runs ${file}, ${UNRESOLVED}`)];
  }
  if (!isWritable(file, ctx)) {
    return [risky("outside_worktree", `Runs the script ${file}, outside the worktree`)];
  }
  const local = follow ? readLocalScript(file, ctx, ctx.work) : ({ kind: "too_large" } as const);
  if (local.kind === "too_large") return [TOO_LARGE];
  if (local.kind === "missing") {
    return script.sourced
      ? [risky("other", `Runs a script file whose contents aren't read (${file})`)]
      : [];
  }
  try {
    return shellReadings(local.text, "posix", ctx).map(classify);
  } catch (err) {
    // Nested so deep (`((((…`) that reading it ran out of stack.
    if (err instanceof RangeError) return [TOO_LARGE];
    throw err;
  }
}
