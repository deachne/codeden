import type { ItemOf } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "@/components/thread/cards/approval-card";
import { renderWithClient } from "./utils";

const RM = "rm -r /Users/me/.forge && ls -d /Users/me/.forge";

const item: ItemOf<"approval_request"> = {
  id: "a1",
  kind: "approval_request",
  status: "in_progress",
  requestId: "r1",
  action: "outside_worktree",
  title: "Run a command outside the worktree",
  reason: "Deletes files outside the worktree",
  command: RM,
  options: ["allow_once", "allow_session", "deny"],
};

/** Approval cards in plain words (#5). */
describe("ApprovalCard with a plain-words explanation", () => {
  it("shows the five lines, red and can't be undone, with the command under Details", () => {
    const { container } = renderWithClient(
      <ApprovalCard
        item={{
          ...item,
          explanation: {
            whatItDoes: "Deletes a folder an old tool left behind",
            why: "The session is cleaning up the old setup",
            advice: { verdict: "deny", reason: "It can't be got back" },
            undoable: false,
            risk: "red",
          },
        }}
        sessionId="s1"
      />,
    );
    for (const label of ["What it does", "Why", "Can it be undone", "Risk", "Advice"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Deletes a folder an old tool left behind")).toBeTruthy();
    expect(screen.getByText("No, it can't be undone")).toBeTruthy();
    expect(container.querySelector("[data-risk='red']")?.textContent).toContain("High (red)");
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(RM);
    expect(screen.getByRole("button", { name: /Approve/ })).toBeTruthy();
  });

  it("shows why it can't be undone beside the answer, and nothing when there is no reason", () => {
    const explanation = {
      whatItDoes: "Discards your edits to every file",
      why: "The session wants a clean tree",
      advice: { verdict: "deny" as const, reason: "Unsaved work would be lost" },
      undoable: false,
      risk: "yellow" as const,
    };
    const withReason = renderWithClient(
      <ApprovalCard
        item={{
          ...item,
          explanation: {
            ...explanation,
            notUndoableReason: "throws away unsaved edits to that file",
          },
        }}
        sessionId="s1"
      />,
    );
    expect(
      withReason.container.querySelector("[data-testid='approval-not-undoable-reason']")
        ?.textContent,
    ).toContain("throws away unsaved edits to that file");
    withReason.unmount();
    const without = renderWithClient(
      <ApprovalCard item={{ ...item, explanation }} sessionId="s1" />,
    );
    expect(screen.getByText("No, it can't be undone")).toBeTruthy();
    expect(
      without.container.querySelector("[data-testid='approval-not-undoable-reason']"),
    ).toBeNull();
  });

  it("keeps today's layout without one", () => {
    const { container } = renderWithClient(<ApprovalCard item={item} sessionId="s1" />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("[data-testid='approval-explanation']")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain(RM);
  });
});
