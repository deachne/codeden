import type { AutomationRun, RecipeStep, RecipeStepRun } from "@codeden/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { StatusDot } from "@/components/common/status-dot";
import type { Tone } from "@/lib/format";
import { RecipeAnswerButtons } from "./recipe-answer";
import { STEP_KIND, stepText } from "./recipe-editor";

/** How a step of a recipe run reads, in plain words. */
export const STEP_STATUS: Record<RecipeStepRun["status"], { label: string; tone: Tone }> = {
  pending: { label: "Not reached yet", tone: "idle" },
  running: { label: "Running", tone: "running" },
  waiting: { label: "Waiting for your OK", tone: "waiting" },
  done: { label: "Done", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  stopped: { label: "Stopped", tone: "idle" },
};

/** "Step 2 of 3", the step a run is on (the first that isn't over); null once all are done. */
export function currentStepNumber(run: AutomationRun): { at: number; of: number } | null {
  const state = run.recipe;
  if (!state) return null;
  const at = state.steps.findIndex(
    (s) => s.status !== "done" && s.status !== "failed" && s.status !== "stopped",
  );
  return at === -1 ? null : { at: at + 1, of: state.steps.length };
}

/**
 * A recipe run's steps (§10): which one it is on, what each did, and, when it waits for you,
 * the question with Yes and No. `steps` come from the recipe, so each step shows its wording.
 */
export function RecipeRunSteps({
  run,
  steps,
}: {
  run: AutomationRun;
  steps: readonly RecipeStep[] | undefined;
}) {
  const state = run.recipe;
  if (!state) return null;
  const active = run.status === "running" || run.status === "queued";
  const now = currentStepNumber(run);
  return (
    <div
      className="space-y-1 border-b border-border bg-surface/50 px-3.5 py-2 last:border-0"
      data-testid="recipe-run-steps"
    >
      {now && active && (
        <p className="text-2xs text-muted-foreground" data-testid="recipe-run-position">
          On step {now.at} of {now.of}
        </p>
      )}
      <ol className="space-y-1.5">
        {state.steps.map((stepRun, i) => {
          const step = steps?.find((s) => s.id === stepRun.stepId);
          const status = STEP_STATUS[stepRun.status];
          return (
            <li key={stepRun.stepId} className="text-[13px]" data-status={stepRun.status}>
              <div className="flex items-center gap-2">
                <StatusDot tone={status.tone} />
                <span className="font-medium">
                  {i + 1}. {step ? STEP_KIND[step.type].label : "Step"}
                </span>
                <span className="text-2xs text-muted-foreground">{status.label}</span>
                {stepRun.sessionId && (
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: stepRun.sessionId }}
                    className="ml-auto flex items-center gap-0.5 text-2xs text-primary hover:underline"
                  >
                    Session <ArrowUpRight className="size-3" />
                  </Link>
                )}
              </div>
              {step && (
                <p className="ml-4 line-clamp-2 text-2xs text-muted-foreground">{stepText(step)}</p>
              )}
              {stepRun.result && stepRun.status !== "pending" && (
                <p className="ml-4 line-clamp-3 text-2xs">{stepRun.result}</p>
              )}
              {stepRun.status === "waiting" && stepRun.inboxItemId && active && (
                <div className="ml-4 mt-1.5 space-y-1.5">
                  <p className="text-2xs font-medium text-status-waiting">
                    Waiting for: {step?.type === "ask_owner" ? step.question : "your OK"}
                  </p>
                  <RecipeAnswerButtons itemId={stepRun.inboxItemId} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
