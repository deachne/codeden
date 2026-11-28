import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { prepareWorkspace } from "../src/workspace/worktree";
import { removeDir, sh, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

/** A repository with no commit at all, as a brand-new GitHub repository is when cloned. */
function emptyRepo(): string {
  const dir = tempDir("codeden-empty-");
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "user.email", "test@example.com");
  return dir;
}

describe("a worktree in a repository with no commits", () => {
  it("is prepared, with a branch to work on", async () => {
    const repo = emptyRepo();
    const home = tempDir("codeden-home-");
    dirs.push(home);
    const ctx = { home, supervisor: new ProcessSupervisor(), emit: () => undefined };
    const result = await prepareWorkspace(
      {
        name: "workspace.prepare",
        sessionId: "sess-empty",
        repoPath: repo,
        strategy: "worktree",
        setupCommands: [],
        baseRef: "main",
      },
      ctx,
    );
    expect(result.cwd).not.toBe(repo);
    expect(result.branch).toBeTruthy();
  });
});
