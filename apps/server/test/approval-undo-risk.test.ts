import type { ApprovalAction, ItemOf } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { undoRisk } from "../src/services/approvals/undo-risk";

function approval(
  command: string | undefined,
  action: ApprovalAction = "outside_worktree",
  reason = "Writes outside the worktree",
): ItemOf<"approval_request"> {
  return {
    id: "a1",
    kind: "approval_request",
    status: "in_progress",
    requestId: "r1",
    action,
    title: "Approve",
    reason,
    ...(command === undefined ? {} : { command }),
    options: ["allow_once", "allow_session", "deny"],
  };
}

describe("can it be undone, and how risky (#5)", () => {
  it.each([
    ["rm -r /Users/me/.forge && ls -d /Users/me/.forge", false, "red"],
    ["sudo rm -rf /opt/old", false, "red"],
    ["find /Users/me/old -name '*.log' -delete", false, "red"],
    ["Remove-Item -Recurse C:\\old", false, "red"],
    ["echo $(rm -rf /x)", false, "red"],
    ["mv /Users/me/.forge ~/.Trash/", true, "yellow"],
    ["trash /Users/me/.forge", true, "yellow"],
    ['osascript -e \'tell application "Finder" to delete POSIX file "/x"\'', true, "yellow"],
    ["ls -la /Users/me", true, "yellow"],
    ["echo hi > /Users/me/notes.txt", false, "yellow"],
    ["cp a /Users/me/b", false, "yellow"],
    ["some-unknown-tool --go", false, "yellow"],
  ] as const)("%s → undoable %s, %s", (command, undoable, risk) => {
    expect(undoRisk(approval(command))).toMatchObject({ undoable, risk });
  });

  it("marks secrets and destructive git red whatever the command", () => {
    expect(undoRisk(approval("cat ~/.ssh/id_rsa", "secrets")).risk).toBe("red");
    expect(undoRisk(approval("git push --force", "git_destructive")).risk).toBe("red");
  });

  it("is green when it asks only because of Supervised, unless it deletes for good", () => {
    const supervised = "Supervised mode: every edit and command needs approval";
    expect(undoRisk(approval("pnpm test", "command", supervised)).risk).toBe("green");
    expect(undoRisk(approval("rm -rf dist", "command", supervised))).toMatchObject({
      risk: "yellow",
      undoable: false,
    });
  });

  it("counts edits and tools without a command as not undoable outside a worktree", () => {
    expect(undoRisk(approval(undefined, "file_change")).undoable).toBe(false);
    expect(undoRisk(approval(undefined, "tool")).undoable).toBe(false);
  });
});

describe("what a worktree's checkpoints can undo (#19)", () => {
  const inWorktree = { inWorktree: true };
  it.each([
    [undefined, "file_change", true],
    ["pnpm test", "command", true],
    ["echo hi > notes.txt && git commit -am wip", "command", true],
    ["rm -rf dist", "command", false],
    ["git clean -fdx", "command", false],
    ["git push origin HEAD", "command", false],
    ["pnpm publish", "command", false],
    ["curl -X POST https://example.com", "command", false],
    ["cp a /Users/me/b", "outside_worktree", false],
    ["curl https://example.com", "network", false],
    [undefined, "tool", false],
    ["git push --force", "git_destructive", false],
  ] as const)("%s (%s) → undoable %s", (command, action, undoable) => {
    expect(undoRisk(approval(command, action), inWorktree).undoable).toBe(undoable);
  });
});
