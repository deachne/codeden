import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Session, StartSessionRequest } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { type PreviewDeps, startPreview, stopPreview } from "../src/services/preview";
import { sampleSession } from "./helpers";

/** A project folder, with or without a devServer in its `.codeden/project.json`. */
function project(devServer?: unknown): Project {
  const path = mkdtempSync(join(tmpdir(), "preview-"));
  if (devServer) {
    mkdirSync(join(path, ".codeden"));
    writeFileSync(join(path, ".codeden/project.json"), JSON.stringify({ devServer }));
  }
  return { id: "p1", kind: "local", path } as unknown as Project;
}

/** Scripted sessions: no runner, no agent turns. */
function deps() {
  const live: Session[] = [];
  const start = vi.fn(async (req: StartSessionRequest) => {
    const s = {
      ...sampleSession,
      id: `s${live.length + 1}`,
      workKey: req.workKey,
      status: "running",
    };
    live.push(s as Session);
    return { status: "started" as const, sessionId: s.id };
  });
  const stop = vi.fn(async (id: string) => {
    const s = live.find((x) => x.id === id);
    if (s) s.status = "stopped";
    return { status: "stopped" as const };
  });
  const d: PreviewDeps = {
    prBranch: async (_id: string, n: number) => `pr-branch-${n}`,
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) as never,
    sessions: { start, stop } as never,
    archive: vi.fn(async () => ({})),
    sessionRepo: {
      list: ({ workKey }) => live.filter((s) => s.workKey === workKey),
    },
  };
  return { d, start, stop, live };
}

describe("start_preview", () => {
  it("keys a preview by PR number and reuses it, also for overlapping calls", async () => {
    const { d, start } = deps();
    const p = project({ command: "npm start", port: 3000 });
    const [a, b] = await Promise.all([
      startPreview(d, p, { prNumber: 7 }),
      startPreview(d, p, { prNumber: 7 }),
    ]);
    expect(a.status).toBe("started");
    expect(b).toEqual(a);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0].workKey).toBe("preview:pr-branch-7");
    expect((await startPreview(d, p, { prNumber: 7 })).status).toBe("reused");
    expect((await stopPreview(d, p, { prNumber: 7 })).status).toBe("stopped");
  });

  it("returns the URL and the session link when a devServer is set", async () => {
    const { d, start } = deps();
    const res = await startPreview(d, project({ command: "python app.py", port: 5050 }), {
      branch: "feat/x",
    });
    expect(res).toMatchObject({
      status: "started",
      url: "http://127.0.0.1:5050",
      reachableFrom: "this-computer",
      sessionId: "s1",
      sessionLink: "/sessions/s1",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0].workKey).toBe("preview:feat/x");
  });

  it("refuses clearly without a devServer and starts nothing", async () => {
    const { d, start } = deps();
    const res = await startPreview(d, project(), { branch: "feat/x" });
    expect(res.status).toBe("no_dev_server");
    expect(res.message).toContain("Set a devServer in .codeden/project.json");
    expect(start).not.toHaveBeenCalled();
  });

  it("reuses the running preview of the same branch, and can stop it", async () => {
    const { d, start, stop } = deps();
    const p = project("npm start");
    await startPreview(d, p, { branch: "feat/x" });
    const again = await startPreview(d, p, { branch: "feat/x" });
    expect(again).toMatchObject({ status: "reused", sessionId: "s1", url: null });
    expect(start).toHaveBeenCalledOnce();
    expect((await stopPreview(d, p, { branch: "feat/x" })).status).toBe("stopped");
    expect(stop).toHaveBeenCalledWith("s1");
    expect((await stopPreview(d, p, { branch: "feat/x" })).status).toBe("none");
  });

  it("archives the preview session on stop, so its worktree goes", async () => {
    const { d } = deps();
    const archive = d.archive as ReturnType<typeof vi.fn>;
    const p = project("npm start");
    await startPreview(d, p, { branch: "feat/x" });
    await stopPreview(d, p, { branch: "feat/x" });
    expect(archive).toHaveBeenCalledWith("s1");
  });

  it("shares one preview between a pull request and its branch", async () => {
    const { d, start } = deps();
    const p = project("npm start");
    await startPreview(d, p, { prNumber: 7 });
    const again = await startPreview(d, p, { branch: "pr-branch-7" });
    expect(again.status).toBe("reused");
    expect(start).toHaveBeenCalledOnce();
    expect((await stopPreview(d, p, { branch: "pr-branch-7" })).status).toBe("stopped");
  });

  it("does not reuse archived or interrupted preview sessions", async () => {
    const { d, start, live } = deps();
    const p = project("npm start");
    await startPreview(d, p, { branch: "feat/x" });
    (live[0] as { archivedAt: string | null }).archivedAt = "2026-01-01T00:00:00Z";
    expect((await startPreview(d, p, { branch: "feat/x" })).status).toBe("started");
    (live[1] as { status: string }).status = "interrupted";
    expect((await startPreview(d, p, { branch: "feat/x" })).status).toBe("started");
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("fetches origin before reading the devServer of a GitHub branch", async () => {
    const { d } = deps();
    const calls: string[] = [];
    d.exec = (async (...a: unknown[]) => {
      calls.push(JSON.stringify(a));
      return { code: 1, stdout: "", stderr: "" };
    }) as never;
    const p = { ...project(), kind: "github" } as Project;
    await startPreview(d, p, { branch: "feat/x" });
    const fetchAt = calls.findIndex((c) => c.includes("fetch"));
    const showAt = calls.findIndex((c) => c.includes("show"));
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(showAt);
  });

  it("passes -- to git fetch so a branch can't be read as an option", async () => {
    const { d } = deps();
    const calls: string[][] = [];
    d.exec = (async (_c: string, args: string[]) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: "" };
    }) as never;
    const p = { ...project(), kind: "github" } as Project;
    await startPreview(d, p, { branch: "--upload-pack=evil" });
    expect(calls[0]).toEqual(["fetch", "--", "origin", "--upload-pack=evil"]);
  });

  it("reuses the running preview by its work key when the start is a conflict", async () => {
    const { d, start } = deps();
    const p = project("npm start");
    await startPreview(d, p, { branch: "feat/x" });
    start.mockResolvedValueOnce({ status: "conflict" } as never);
    // Hide the running session from the first lookup only, so the fallback has to find it.
    const list = d.sessionRepo.list;
    let calls = 0;
    d.sessionRepo.list = (q) => (calls++ === 0 ? [] : list(q));
    const res = await startPreview(d, p, { branch: "feat/x" });
    expect(res).toMatchObject({ status: "reused", sessionId: "s1" });
  });

  it("stops by pull request what was started by branch", async () => {
    const { d } = deps();
    const p = project("npm start");
    await startPreview(d, p, { branch: "pr-branch-7" });
    expect((await stopPreview(d, p, { prNumber: 7 })).status).toBe("stopped");
  });
});
