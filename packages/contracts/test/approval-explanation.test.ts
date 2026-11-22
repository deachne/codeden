import { describe, expect, it } from "vitest";
import {
  ApprovalExplanation,
  Item,
  keepApprovalExplanation,
  Project,
  Settings,
  UpdateProjectRequest,
} from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const explanation = {
  whatItDoes: "Deletes two empty folders left by an old tool",
  why: "The session is cleaning up after the old setup",
  advice: { verdict: "approve", reason: "Nothing uses them" },
  undoable: false,
  risk: "red",
} as const;

const approval = {
  id: "a1",
  kind: "approval_request",
  status: "in_progress",
  requestId: "r1",
  action: "outside_worktree",
  title: "Delete folders",
  command: "rm -r ~/.forge",
  options: ["allow_once", "allow_session", "deny"],
} as const;

// #5: approvals explained in plain words, and the Delete to the Trash project setting.
describe("plain-words approvals", () => {
  it("round-trips an explained approval, and one without (as before)", () => {
    expect(roundTrip(Item, { ...approval, explanation })).toMatchObject({ explanation });
    expect(roundTrip(Item, approval)).not.toHaveProperty("explanation");
  });

  it("refuses an explanation outside its shape", () => {
    expect(ApprovalExplanation.safeParse({ ...explanation, risk: "purple" }).success).toBe(false);
    expect(
      ApprovalExplanation.safeParse({ ...explanation, whatItDoes: "x".repeat(161) }).success,
    ).toBe(false);
    expect(
      ApprovalExplanation.safeParse({
        ...explanation,
        advice: { verdict: "maybe", reason: "?" },
      }).success,
    ).toBe(false);
  });

  it("keeps the explanation when the provider updates the approval", () => {
    const before = Item.parse({ ...approval, explanation });
    const after = Item.parse({ ...approval, status: "completed", decision: "deny" });
    expect(keepApprovalExplanation(before, after)).toMatchObject({
      status: "completed",
      explanation,
    });
    expect(keepApprovalExplanation(Item.parse(approval), after)).toBe(after);
  });

  it("round-trips the reason an action can't be undone, and accepts explanations without it", () => {
    const withReason = {
      ...explanation,
      undoable: false,
      notUndoableReason: "throws away unsaved edits to that file",
    };
    expect(roundTrip(ApprovalExplanation, withReason)).toEqual(withReason);
    expect(ApprovalExplanation.parse(explanation).notUndoableReason).toBeUndefined();
  });

  it("is off by default, and so is Delete to the Trash", () => {
    expect(Settings.parse({}).utilityModel.jobs.approvalExplanations).toBe(false);
    const { deleteToTrash: _d, ...rest } = sampleProject;
    expect(Project.parse(rest).deleteToTrash).toBe(false);
    expect(roundTrip(Project, { ...sampleProject, deleteToTrash: true }).deleteToTrash).toBe(true);
    expect(roundTrip(UpdateProjectRequest, { deleteToTrash: true })).toEqual({
      deleteToTrash: true,
    });
  });
});
