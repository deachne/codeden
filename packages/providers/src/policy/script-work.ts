import { type RiskAssessment, risky } from "./assessment";

/**
 * How much work one command line's checks may take (§11.2, #153). The scripts a command runs are
 * read and judged too, and those may run others, so a few lines can fan out into millions of
 * commands; the checks run synchronously, so the runner would stand still. One budget is shared by
 * everything a command line reaches; past it nothing more is judged and the command asks.
 */

/** What a command line may cost: the commands judged, and the bytes of script files read. */
export interface WorkLimits {
  commands: number;
  bytes: number;
  /** From the first script file read, in milliseconds. */
  ms: number;
}

export const WORK_LIMITS: WorkLimits = { commands: 4000, bytes: 256 * 1024, ms: 2000 };

export class Work {
  /** True once a limit was passed: what is left of the command line isn't judged. */
  spent = false;
  private commands = 0;
  private bytes = 0;
  private deadline: number | undefined;

  constructor(
    private readonly limits: WorkLimits = WORK_LIMITS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Count one command judged; false when there is no budget left for it. */
  command(): boolean {
    this.commands += 1;
    if (this.commands > this.limits.commands) this.spent = true;
    if (this.deadline !== undefined && this.now() > this.deadline) this.spent = true;
    return !this.spent;
  }

  /** Count a script file of `bytes` about to be read; false when it may not be. */
  script(bytes: number): boolean {
    this.deadline ??= this.now() + this.limits.ms;
    this.bytes += bytes;
    if (this.bytes > this.limits.bytes) this.spent = true;
    return !this.spent;
  }
}

/**
 * The verdict on a command line whose work ran out. What wasn't judged may write anywhere, so it
 * asks as a write outside the worktree does (at Full too).
 */
export const TOO_LARGE: RiskAssessment = risky(
  "outside_worktree",
  "Runs a script that is too large or too nested to check",
);
