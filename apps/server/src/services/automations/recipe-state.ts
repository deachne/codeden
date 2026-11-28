import type {
  AutomationRun,
  RecipeRunState,
  RecipeStep,
  RecipeStepRun,
  RecipeSteps,
} from "@codeden/contracts";

/**
 * The state of a recipe run (§10), as pure functions: the run's steps and where it stands. The
 * runner saves each change as an `automation_run.updated` event, so a restart finds exactly
 * which steps are done.
 */

/** Statuses of a step that is over: the recipe never goes back to it. */
const OVER: ReadonlySet<RecipeStepRun["status"]> = new Set(["done", "failed", "stopped"]);

/** A fresh run: every step pending, the first one up. */
export function newRecipeState(steps: RecipeSteps, byPerson: boolean): RecipeRunState {
  return {
    current: 0,
    byPerson,
    steps: steps.map((s) => ({
      stepId: s.id,
      status: "pending",
      sessionId: null,
      inboxItemId: null,
      answer: null,
      result: null,
      startedAt: null,
      finishedAt: null,
    })),
  };
}

/** The state with step `index` changed. */
export function patchStep(
  state: RecipeRunState,
  index: number,
  patch: Partial<RecipeStepRun>,
): RecipeRunState {
  return {
    ...state,
    steps: state.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
  };
}

/** The step done, and the next one up. */
export function completeStep(
  state: RecipeRunState,
  index: number,
  now: string,
  patch: Partial<RecipeStepRun> = {},
): RecipeRunState {
  return {
    ...patchStep(state, index, { ...patch, status: "done", finishedAt: now }),
    current: index + 1,
  };
}

/** The step the run stopped on, closed with its reason (the run ends here). */
export function endStep(
  state: RecipeRunState,
  index: number,
  status: "failed" | "stopped",
  result: string,
  now: string,
  patch: Partial<RecipeStepRun> = {},
): RecipeRunState {
  return patchStep(state, index, { ...patch, status, result, finishedAt: now });
}

/**
 * The state of a run that was given up on from outside (a session cut off for too long): the
 * step it was on fails with the reason; steps not reached stay pending.
 */
export function endRecipeRun(
  run: AutomationRun,
  reason: string,
  now: string,
): RecipeRunState | null | undefined {
  const state = run.recipe;
  if (!state) return state;
  const step = state.steps[state.current];
  if (!step || OVER.has(step.status)) return state;
  return endStep(state, state.current, "failed", reason, now);
}

/** The first step of the recipe that isn't over, or the number of steps when all are. */
export function firstUnfinished(state: RecipeRunState): number {
  const at = state.steps.findIndex((s) => !OVER.has(s.status));
  return at === -1 ? state.steps.length : at;
}

/** The marker text of a run waiting for the owner's answer (shown as its progress). */
export const RECIPE_WAITING_TEXT = "Waiting for your OK: ";

/** A short plain-words name for a step, for progress lines and messages. */
export function stepLabel(step: RecipeStep, index: number, total: number): string {
  const n = `Step ${index + 1} of ${total}`;
  switch (step.type) {
    case "start_session":
      return `${n}: ${step.title ?? "start a session"}`;
    case "message_pm":
      return `${n}: tell the PM`;
    case "ask_owner":
      return `${n}: ask you`;
  }
}
