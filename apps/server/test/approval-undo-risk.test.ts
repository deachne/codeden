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
    // Yes: an edit, or a command made only of reads and commands known to stay local.
    [undefined, "file_change", true],
    ["pnpm test", "command", true],
    ["pnpm run build && pnpm lint", "command", true],
    ["echo hi > notes.txt && git add -A && git commit -m wip", "command", true],
    ["mkdir -p src/x && touch src/x/a.ts && cp a b && mv b c", "command", true],
    ["sed -i '' s/a/b/ file.ts", "command", true],
    ["git checkout -b x && git stash push -m wip", "command", true],
    ["git restore --staged file.ts", "command", true],
    ["tsc --noEmit && vitest run", "command", true],
    ["cargo test && go build ./...", "command", true],
    // No: deletions, anything off the machine, package installs, and every program CodeDen doesn't know.
    ["npm install", "command", false],
    ["git checkout -- file.ts", "command", false],
    ["git restore file.ts", "command", false],
    ["rm -rf dist", "command", false],
    ["git clean -fdx", "command", false],
    ["git push origin HEAD", "command", false],
    ["git stash drop", "command", false],
    ["pnpm publish", "command", false],
    ["pnpm run deploy", "command", false],
    ["npm install -g something", "command", false],
    ["npx vercel --prod", "command", false],
    ["kubectl delete pod x", "command", false],
    ["aws s3 rm s3://b/k", "command", false],
    ["docker push img", "command", false],
    ["psql -c 'drop table x'", "command", false],
    ["node scripts/deploy.js", "command", false],
    ["pnpm test && kubectl apply -f prod.yaml", "command", false],
    ["curl -X POST https://example.com", "command", false],
    ["make", "command", false],
    ["cp a /Users/me/b", "outside_worktree", false],
    ["curl https://example.com", "network", false],
    [undefined, "tool", false],
    ["git push --force", "git_destructive", false],
  ] as const)("%s (%s) → undoable %s", (command, action, undoable) => {
    expect(undoRisk(approval(command, action), inWorktree).undoable).toBe(undoable);
  });

  it("says no to a local command outside a worktree of its own", () => {
    expect(undoRisk(approval("pnpm test", "command")).undoable).toBe(false);
  });

  it("marks git checkout -- path and git restore with a plain reason", () => {
    expect(undoRisk(approval("git checkout -- src/a.ts", "command"), inWorktree)).toMatchObject({
      undoable: false,
      reason: "throws away unsaved edits to that file",
    });
    expect(
      undoRisk(approval("git checkout HEAD -- src/a.ts", "command"), inWorktree),
    ).toMatchObject({
      undoable: false,
      reason: "throws away unsaved edits to that file",
    });
    expect(undoRisk(approval("git restore src/a.ts", "command"), inWorktree)).toMatchObject({
      undoable: false,
      reason: "throws away unsaved edits to that file",
    });
    expect(
      undoRisk(approval("git restore --staged src/a.ts", "command"), inWorktree).undoable,
    ).toBe(true);
  });
});
