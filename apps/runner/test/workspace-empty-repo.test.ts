import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { removeWorkspace } from "../src/workspace/removal";
import { prepareWorkspace } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

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

function context() {
  const home = tempDir("codeden-home-");
  dirs.push(home);
  return { home, ctx: { home, supervisor: new ProcessSupervisor(), emit: () => undefined } };
}

const prepare = (sessionId: string, repoPath: string, extra: Record<string, unknown> = {}) => ({
  name: "workspace.prepare" as const,
  sessionId,
  repoPath,
  strategy: "worktree" as const,
  setupCommands: [],
  baseRef: "main",
  ...extra,
});

// Git-heavy (worktrees, fetches): slow on loaded Windows runners.
describe("a worktree in a repository with no commits", () => {
  it("is a new history-free branch the session can commit to, and is reused", async () => {
    const repo = emptyRepo();
    const { ctx } = context();
    const result = await prepareWorkspace(prepare("sess-empty", repo), ctx);
    expect(result.cwd).not.toBe(repo);
    expect(result.branch).toMatch(/^codeden\//);
    expect(sh(result.cwd, "symbolic-ref", "--short", "HEAD")).toBe(result.branch);

    write(result.cwd, "README.md", "# hello\n");
    sh(result.cwd, "add", "-A");
    sh(result.cwd, "commit", "-q", "-m", "first");
    expect(sh(repo, "rev-parse", "--verify", `refs/heads/${result.branch}`)).toBeTruthy();
    // The owner's checkout is untouched: still no commit, no file.
    expect(existsSync(join(repo, "README.md"))).toBe(false);
    expect(() => sh(repo, "rev-parse", "--verify", "HEAD")).toThrow();

    const again = await prepareWorkspace(prepare("sess-empty", repo), ctx);
    expect(again.cwd).toBe(result.cwd);
    expect(again.branch).toBe(result.branch);
  });

  it("branches from origin/<default> once it has a commit, though the local HEAD is unborn", async () => {
    const upstream = makeRepo({ "fresh.txt": "upstream work\n" });
    const repo = emptyRepo();
    dirs.push(upstream);
    sh(repo, "remote", "add", "origin", upstream);
    const { ctx } = context();
    const result = await prepareWorkspace(prepare("sess-fetch", repo, { fetch: true }), ctx);
    expect(existsSync(join(result.cwd, "fresh.txt"))).toBe(true);
    expect(sh(result.cwd, "rev-parse", "HEAD")).toBe(sh(upstream, "rev-parse", "main"));
  });

  it("checks out a branch that already has commits when its worktree is made again", async () => {
    const repo = emptyRepo();
    const { home, ctx } = context();
    const first = await prepareWorkspace(prepare("sess-restore", repo), ctx);
    write(first.cwd, "kept.txt", "kept\n");
    sh(first.cwd, "add", "-A");
    sh(first.cwd, "commit", "-q", "-m", "work");
    await removeWorkspace({ name: "workspace.remove", repoPath: repo, path: first.cwd }, home);
    expect(existsSync(first.cwd)).toBe(false);

    const again = await prepareWorkspace(
      prepare("sess-restore", repo, { branch: first.branch }),
      ctx,
    );
    expect(again.branch).toBe(first.branch);
    expect(existsSync(join(again.cwd, "kept.txt"))).toBe(true);
  });

  it("does not hide a bad branch name behind the 'git too old' message", async () => {
    const repo = emptyRepo();
    const { ctx } = context();
    const error = await prepareWorkspace(prepare("sess-bad", repo, { branch: "bad..branch" }), ctx)
      .then(() => null)
      .catch((e: unknown) => e as { code?: string; message?: string });
    expect(error).not.toBeNull();
    expect(error?.code).not.toBe("empty_repo");
    expect(error?.message).not.toMatch(/too old/);
  });
});

describe("a worktree in a repository that has commits", () => {
  it("still branches from the default branch (no orphan)", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const { ctx } = context();
    const result = await prepareWorkspace(prepare("sess-full", repo), ctx);
    expect(sh(result.cwd, "rev-parse", "HEAD")).toBe(sh(repo, "rev-parse", "main"));
  });

  it("still fails for a base that doesn't exist, instead of an empty worktree", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const { ctx } = context();
    await expect(
      prepareWorkspace(prepare("sess-nobase", repo, { baseRef: "nope" }), ctx),
    ).rejects.toThrow(/invalid reference/);
  });
});
