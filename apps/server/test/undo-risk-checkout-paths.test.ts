import type { ItemOf } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { undoRisk } from "../src/services/approvals/undo-risk";

function approval(command: string): ItemOf<"approval_request"> {
  return {
    id: "a1",
    kind: "approval_request",
    status: "in_progress",
    requestId: "r1",
    action: "command",
    title: "Run command",
    reason: "Command needs approval",
    command,
    options: ["allow_once", "allow_session", "deny"],
  };
}

// Issue #49: checkout arguments that are paths (not branches) discard unsaved work
describe("undo risk for git checkout of paths without -- (#49)", () => {
  const inWorktree = { inWorktree: true };

  it.each([
    "git checkout .",
    "git checkout src/a.ts",
    "git checkout ./src",
    "git checkout HEAD src/a.ts",
  ])("'%s' is not undoable and carries a reason", (command) => {
    const result = undoRisk(approval(command), inWorktree);
    expect(result.undoable).toBe(false);
    expect(result.reason).toBe("throws away unsaved edits to that file");
  });

  it.each(["git checkout main", "git checkout -b feature/x", "git checkout feature/x"])(
    "'%s' (a branch) stays undoable",
    (command) => {
      expect(undoRisk(approval(command), inWorktree).undoable).toBe(true);
    },
  );
});
