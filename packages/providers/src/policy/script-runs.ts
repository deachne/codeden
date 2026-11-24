import { type RiskAssessment, risky } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isWritable } from "./paths";
import {
  isProjectVenv,
  isSetupFile,
  OTHER_HOME,
  readLocalScript,
  shellScriptFile,
} from "./script-files";
import { selfReadings } from "./script-self";
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
  classify: (list: SimpleCommand[], there: RiskContext) => RiskAssessment,
): RiskAssessment[] {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const script = shellScriptFile(bin, tokens.slice(1), cmd.inputFiles);
  if (!script) return [];
  const { file } = script;
  if (script.sourced && isSetupFile(file, ctx)) return [];
  if (unresolvedTarget(cmd, file, ctx)) {
    return [risky("outside_worktree", `Runs ${file}, ${UNRESOLVED}`)];
  }
  if (!isWritable(file, ctx) || OTHER_HOME.test(file)) {
    return [risky("outside_worktree", `Runs the script ${file}, outside the worktree`)];
  }
  const local = follow ? readLocalScript(file, ctx, ctx.work) : ({ kind: "too_large" } as const);
  if (local.kind === "too_large") return [TOO_LARGE];
  if (local.kind === "missing") {
    return script.sourced && !isProjectVenv(file, ctx)
      ? [risky("other", `Runs a script file whose contents aren't read (${file})`)]
      : [];
  }
  try {
    const { text } = local;
    const there = {
      ...ctx,
      cdPath: ctx.cdPath || /\bCDPATH\b/.test(text),
      gitEnv: ctx.gitEnv || /\bGIT_(?:DIR|WORK_TREE)\b/.test(text),
    };
    return selfReadings(text, { file, bin }, there)
      .flatMap((prepare) => shellReadings(text, "posix", there, undefined, prepare))
      .map((list) => classify(list, there));
  } catch (err) {
    // Nested so deep (`((((…`) that reading it ran out of stack.
    if (err instanceof RangeError) return [TOO_LARGE];
    throw err;
  }
}
