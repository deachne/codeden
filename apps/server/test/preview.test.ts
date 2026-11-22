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
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) as never,
    sessions: { start, stop } as never,
    sessionRepo: {
      list: ({ workKey }) => live.filter((s) => s.workKey === workKey),
    },
  };
  return { d, start, stop };
}

describe("start_preview", () => {
  it("returns the URL and the session link when a devServer is set", async () => {
    const { d, start } = deps();
    const res = await startPreview(d, project({ command: "python app.py", port: 5050 }), "feat/x");
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
    const res = await startPreview(d, project(), "feat/x");
    expect(res.status).toBe("no_dev_server");
    expect(res.message).toContain("Set a devServer in .codeden/project.json");
    expect(start).not.toHaveBeenCalled();
  });

  it("reuses the running preview of the same branch, and can stop it", async () => {
    const { d, start, stop } = deps();
    const p = project("npm start");
    await startPreview(d, p, "feat/x");
    const again = await startPreview(d, p, "feat/x");
    expect(again).toMatchObject({ status: "reused", sessionId: "s1", url: null });
    expect(start).toHaveBeenCalledOnce();
    expect((await stopPreview(d, p, "feat/x")).status).toBe("stopped");
    expect(stop).toHaveBeenCalledWith("s1");
    expect((await stopPreview(d, p, "feat/x")).status).toBe("none");
  });
});
