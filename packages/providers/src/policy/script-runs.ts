import { type RiskAssessment, risky } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isWin, isWritable } from "./paths";
import {
  isProjectVenv,
  OTHER_HOME,
  readLocalScript,
  type ScriptFileOperand,
  shellScriptFile,
} from "./script-files";
import { keepsMeaning, selfReadings } from "./script-self";
import { TOO_LARGE } from "./script-work";
import type { SimpleCommand } from "./shell";
import { shellReadings } from "./shell-readings";
import { startupFile } from "./shells";
import type { RiskContext } from "./targets";
import { isSetupFile } from "./tool-folders";
import { UNRESOLVED, unresolvedTarget } from "./variables";

type Classify = (list: SimpleCommand[], there: RiskContext) => RiskAssessment;

/**
 * The verdicts on the script files `cmd` runs (`./script-files`), if any: the one it is given or
 * reads its commands from (its own input, or that of what it is in: `(bash) < file`), and a start-up
 * file (`bash --rcfile f`). One outside the worktree asks, and one inside it is read and its
 * commands judged by `classify`, like an inline script's. `follow`: the script isn't nested deeper
 * than is followed. Where the work for the command line runs out (`./script-work`), or a script
 * can't be parsed, it asks.
 */
export function scriptFileRisks(
  cmd: SimpleCommand,
  ctx: RiskContext,
  follow: boolean,
  classify: Classify,
): RiskAssessment[] {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const fed = ctx.stdin?.file;
  const own = cmd.inputFiles || cmd.input || cmd.heredocs || cmd.piped || fed === undefined;
  const script = shellScriptFile(bin, args, own ? cmd.inputFiles : [fed]);
  const startup = startupFile(bin, args);
  const files: ScriptFileOperand[] = startup ? [{ file: startup, sourced: true }] : [];
  if (script) files.push(script);
  return files.flatMap((one) => fileRisks(one, bin, cmd, ctx, follow, classify));
}

function fileRisks(
  script: ScriptFileOperand,
  bin: string,
  cmd: SimpleCommand,
  ctx: RiskContext,
  follow: boolean,
  classify: Classify,
): RiskAssessment[] {
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
    const texts = (ctx.work?.texts ?? []).filter((t) => t !== text);
    if (texts.length === ctx.work?.texts.length) ctx.work.texts.push(text);
    const run = { file, bin, env: ctx.env ?? process.env, texts };
    const folders = !isWin(ctx) && keepsMeaning(text, there);
    return selfReadings(text, run, there)
      .flatMap((prepare) => shellReadings(text, "posix", there, undefined, prepare, folders))
      .map((list) => classify(list, there));
  } catch (err) {
    // Nested so deep (`((((…`) that reading it ran out of stack.
    if (err instanceof RangeError) return [TOO_LARGE];
    throw err;
  }
}
