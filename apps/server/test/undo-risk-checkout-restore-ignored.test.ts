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

// Issue #24: Approval cards say "can be undone" for git checkout/restore of a path, and for files git ignores
describe("undo risk for checkout/restore of paths and package installs (#24)", () => {
  const inWorktree = { inWorktree: true };

  it("marks git checkout of a path as not undoable with a plain reason", () => {
    const result = undoRisk(approval("git checkout -- src/a.ts"), inWorktree);
    expect(result.undoable).toBe(false);
    expect(result.reason).toBe("throws away unsaved edits to that file");

    const headResult = undoRisk(approval("git checkout HEAD -- src/a.ts"), inWorktree);
    expect(headResult.undoable).toBe(false);
    expect(headResult.reason).toBe("throws away unsaved edits to that file");
  });

  it("marks git restore of a path as not undoable with a plain reason, while staged stays undoable", () => {
    const result = undoRisk(approval("git restore src/a.ts"), inWorktree);
    expect(result.undoable).toBe(false);
    expect(result.reason).toBe("throws away unsaved edits to that file");

    const staged = undoRisk(approval("git restore --staged src/a.ts"), inWorktree);
    expect(staged.undoable).toBe(true);
  });

  it.each([
    "npm install",
    "pnpm install",
    "pnpm add zod",
    "yarn add lodash",
    "yarn",
    "bun install",
    "npm i",
    "pnpm i",
  ])("marks package install '%s' as not undoable because it touches ignored files", (command) => {
    const result = undoRisk(approval(command), inWorktree);
    expect(result.undoable).toBe(false);
  });
});
