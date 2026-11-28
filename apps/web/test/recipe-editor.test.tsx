import type { AutomationRun, RecipeStep } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AutomationForm } from "@/components/automations/automation-form";
import { type AutomationDraft, blankDraft, draftProblems } from "@/components/automations/draft";
import { RecipeRunSteps } from "@/components/automations/recipe-run-steps";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const steps: RecipeStep[] = [
  { id: "build", type: "start_session", prompt: "Build the feature" },
  { id: "ok", type: "ask_owner", question: "OK to go on?" },
  { id: "ship", type: "start_session", prompt: "Finish it" },
];

function Harness({ onDraft }: { onDraft: (d: AutomationDraft) => void }) {
  const [draft, setDraft] = useState<AutomationDraft>({
    ...blankDraft("auto"),
    name: "Ship it",
    trigger: { type: "manual" },
    action: { type: "recipe", steps },
  });
  return (
    <AutomationForm
      draft={draft}
      onChange={(d) => {
        setDraft(d);
        onDraft(d);
      }}
      projectTimezone="UTC"
      defaultAutonomy="auto"
      docKey="test"
      defaultWorkKey="automation:<name>"
    />
  );
}

const lastSteps = (onDraft: ReturnType<typeof vi.fn>): RecipeStep[] => {
  const action = onDraft.mock.lastCall?.[0].action;
  return action.type === "recipe" ? action.steps : [];
};

describe("the recipe editor", () => {
  it("shows the steps in order, in plain words", async () => {
    renderWithClient(<Harness onDraft={vi.fn()} />);
    const cards = await screen.findAllByTestId("recipe-step");
    expect(cards.map((c) => c.getAttribute("data-kind"))).toEqual([
      "start_session",
      "ask_owner",
      "start_session",
    ]);
    expect(within(cards[1] as HTMLElement).getByText("Pause and ask me")).toBeTruthy();
  });

  it("adds, moves and removes steps", async () => {
    const onDraft = vi.fn();
    renderWithClient(<Harness onDraft={onDraft} />);
    await screen.findAllByTestId("recipe-step");

    fireEvent.click(screen.getByRole("button", { name: /Tell the PM/ }));
    expect(lastSteps(onDraft).map((s) => s.type)).toEqual([
      "start_session",
      "ask_owner",
      "start_session",
      "message_pm",
    ]);
    // Every step keeps its own id.
    expect(new Set(lastSteps(onDraft).map((s) => s.id)).size).toBe(4);

    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    expect(lastSteps(onDraft).map((s) => s.id)).toEqual(["ok", "build", "ship", "step-4"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(lastSteps(onDraft).map((s) => s.id)).toEqual(["build", "ship", "step-4"]);
  });

  it("says which step still needs words before it can be saved", () => {
    const draft: AutomationDraft = {
      ...blankDraft("auto"),
      name: "Ship it",
      trigger: { type: "manual" },
      action: {
        type: "recipe",
        steps: [
          { id: "a", type: "start_session", prompt: "Do it" },
          { id: "b", type: "message_pm", message: " " },
          { id: "c", type: "ask_owner", question: "" },
        ],
      },
    };
    expect(draftProblems(draft, "UTC")).toEqual([
      "Step 2: write the message.",
      "Step 3: write the question.",
    ]);
  });
});

const recipeRun = (patch: Partial<AutomationRun> = {}): AutomationRun => ({
  id: "run-1",
  automationId: "a-1",
  projectId: "p-storefront",
  status: "running",
  triggeredBy: "manual",
  startedBy: { kind: "automation", id: "a-1" },
  purpose: "Ship it",
  workKey: "automation:ship-it",
  scope: { projectId: "p-storefront" },
  progress: { text: "Waiting for your OK: OK to go on?", at: "2026-11-12T08:00:00.000Z" },
  skipReason: null,
  sessionId: null,
  issueNumber: null,
  startedAt: "2026-11-12T08:00:00.000Z",
  finishedAt: null,
  error: null,
  recipe: {
    current: 1,
    byPerson: true,
    steps: [
      {
        stepId: "build",
        status: "done",
        sessionId: null,
        inboxItemId: null,
        answer: null,
        result: "Built it",
        startedAt: null,
        finishedAt: null,
      },
      {
        stepId: "ok",
        status: "waiting",
        sessionId: null,
        inboxItemId: "inbox:recipe-question:run-1:ok",
        answer: null,
        result: null,
        startedAt: null,
        finishedAt: null,
      },
      {
        stepId: "ship",
        status: "pending",
        sessionId: null,
        inboxItemId: null,
        answer: null,
        result: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
  },
  ...patch,
});

describe("a recipe run", () => {
  it("shows the step it is on and what it waits for, and sends your answer", async () => {
    const client = createMockClient();
    const answer = vi
      .spyOn(client.automations, "answerRecipe")
      .mockResolvedValue({ item: {} as never, run: recipeRun() });
    renderWithClient(<RecipeRunSteps run={recipeRun()} steps={steps} />, client, {
      withRouter: true,
    });

    expect((await screen.findByTestId("recipe-run-position")).textContent).toBe("On step 2 of 3");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["done", "waiting", "pending"]);
    expect(screen.getByText("Waiting for: OK to go on?")).toBeTruthy();
    expect(screen.getByText("Built it")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Yes, carry on/ }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith("inbox:recipe-question:run-1:ok", "yes"),
    );
  });

  it("offers no answer once the run has ended", async () => {
    renderWithClient(
      <RecipeRunSteps run={recipeRun({ status: "cancelled" })} steps={steps} />,
      createMockClient(),
      { withRouter: true },
    );
    // Wait for the steps to render before asserting what is absent.
    await screen.findByTestId("recipe-run-steps");
    expect(screen.queryByRole("button", { name: /Yes, carry on/ })).toBeNull();
    expect(screen.queryByTestId("recipe-run-position")).toBeNull();
  });
});
