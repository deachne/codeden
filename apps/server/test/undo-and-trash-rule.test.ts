import type { ApprovalAction, ItemOf } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { agentPrompt, DELETE_TO_TRASH_RULE, type PromptSession } from "../src/mcp/prompt";
import { undoRisk } from "../src/services/approvals/undo-risk";

/**
 * #19: an explained approval card's "Can it be undone" must say yes for actions checkpoints can
 * undo (an edit, or a command that deletes nothing, inside the session's worktree), and the
 * Trash rule must stay out of the prompt on a runner with no Trash.
 */

function approval(
  action: ApprovalAction,
  command?: string,
  reason = "Supervised mode: every edit and command needs approval",
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

const inWorktree = { inWorktree: true };

describe("can it be undone inside the worktree (#19)", () => {
  it("says an edit inside the worktree can be undone", () => {
    expect(undoRisk(approval("file_change"), inWorktree).undoable).toBe(true);
  });

  it("says a command inside the worktree that deletes nothing can be undone", () => {
    expect(undoRisk(approval("command", "pnpm test"), inWorktree).undoable).toBe(true);
  });

  it("still says a deletion can't be undone", () => {
    expect(undoRisk(approval("command", "rm -rf dist"), inWorktree).undoable).toBe(false);
  });
});

const agent: PromptSession = {
  role: "agent",
  startedBy: { kind: "user" },
  worktreePath: "/home/me/.codeden/wt/shop/abcd1234",
  autonomy: "auto",
};
const project = { kind: "github", deleteToTrash: true } as const;

describe("the Trash rule only where there is a Trash (#19)", () => {
  it("leaves the rule out on a Linux runner", () => {
    const prompt = agentPrompt(agent, project, { platform: "linux" });
    expect(prompt).not.toContain(DELETE_TO_TRASH_RULE);
  });

  it("leaves the rule out in a Docker container", () => {
    const prompt = agentPrompt(agent, project, { platform: "linux", backend: "docker" });
    expect(prompt).not.toContain(DELETE_TO_TRASH_RULE);
  });

  it("keeps the rule on a macOS runner", () => {
    const prompt = agentPrompt(agent, project, { platform: "darwin" });
    expect(prompt).toContain(DELETE_TO_TRASH_RULE);
  });
});
