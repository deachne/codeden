import { describe, expect, it } from "vitest";
import {
  AutomationAction,
  AutomationRun,
  INBOX_ANSWER_KINDS,
  RECIPE_MAX_STEPS,
  RecipeAnswerRequest,
  RecipeRunState,
  RecipeSteps,
  recipeQuestionInboxId,
} from "../src";
import { ts } from "./fixtures";

const steps = [
  { id: "build", type: "start_session", prompt: "Build it", autonomy: "supervised" },
  { id: "tell", type: "message_pm", message: "Heads up" },
  { id: "ok", type: "ask_owner", question: "OK to go on?" },
] as const;

const run = {
  id: "run-1",
  automationId: "a1",
  projectId: "p1",
  status: "running",
  triggeredBy: "manual",
  startedBy: { kind: "automation", id: "a1" },
  purpose: "Ship it",
  workKey: "automation:ship-it",
  scope: { projectId: "p1" },
  progress: null,
  skipReason: null,
  sessionId: null,
  startedAt: ts,
  finishedAt: null,
  error: null,
};

describe("recipes (#194)", () => {
  it("round-trips a recipe action with its three kinds of step", () => {
    const action = AutomationAction.parse({ type: "recipe", steps });
    expect(AutomationAction.parse(JSON.parse(JSON.stringify(action)))).toEqual(action);
  });

  it("needs at least one step, no more than the limit, and a different id for each", () => {
    expect(RecipeSteps.safeParse([]).success).toBe(false);
    expect(RecipeSteps.safeParse([steps[0], { ...steps[1], id: "build" }]).success).toBe(false);
    const many = Array.from({ length: RECIPE_MAX_STEPS + 1 }, (_, i) => ({
      id: `s${i}`,
      type: "message_pm",
      message: "x",
    }));
    expect(RecipeSteps.safeParse(many).success).toBe(false);
    expect(RecipeSteps.safeParse(many.slice(0, RECIPE_MAX_STEPS)).success).toBe(true);
  });

  it("has no release, branching or loop step", () => {
    for (const type of ["release", "branch", "loop"]) {
      expect(RecipeSteps.safeParse([{ id: "x", type }]).success).toBe(false);
    }
  });

  it("keeps a run's state and reads an older run without any", () => {
    const state = RecipeRunState.parse({
      current: 1,
      steps: [
        { stepId: "build", status: "done", sessionId: "s1", result: "Built" },
        { stepId: "ok", status: "waiting", inboxItemId: "inbox:1" },
      ],
    });
    // Fields left out fall back to their defaults.
    expect(state).toMatchObject({ byPerson: false });
    expect(state.steps[1]).toMatchObject({ answer: null, sessionId: null, finishedAt: null });
    expect(AutomationRun.parse({ ...run, recipe: state }).recipe).toEqual(state);
    expect(AutomationRun.parse(run).recipe).toBeUndefined();
    expect(AutomationRun.parse({ ...run, recipe: null }).recipe).toBeNull();
  });

  it("answers a question Yes or No only, on a card with a stable id", () => {
    expect(RecipeAnswerRequest.safeParse({ answer: "yes" }).success).toBe(true);
    expect(RecipeAnswerRequest.safeParse({ answer: "maybe" }).success).toBe(false);
    expect(recipeQuestionInboxId("run-1", "ok")).toBe("inbox:recipe-question:run-1:ok");
    expect(INBOX_ANSWER_KINDS).toContain("recipe_question");
  });
});
