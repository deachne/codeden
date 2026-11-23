import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { events, runners, sessions } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { AutomationExecutor, type ExecutorDeps } from "../src/services/automations/executor";
import { RunStore } from "../src/services/automations/runs";
import { SessionRepo } from "../src/services/sessions/repo";
import { removeTree } from "./support/remove-tree";

/** The limit must run from the interruption, not from the session's last write of any kind. */
describe("RunStore.stranded when the interrupted session keeps being written", () => {
  let dir: string;
  let db: Database;
  let runs: RunStore;
  const hour = 3600_000;
  const now = new Date("2026-11-10T12:00:00.000Z");
  const ago = (h: number) => new Date(now.getTime() - h * hour).toISOString();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-stranded-"));
    db = openDatabase(join(dir, "codeden.db"));
    runs = new RunStore(db.db, new EventStore(db.db));
  });
  afterEach(() => {
    db.close();
    removeTree(dir);
  });

  const addRun = (id: string, status: string, runnerId: string | null = null) => {
    db.db
      .insert(sessions)
      .values({
        id: `s-${id}`,
        role: "agent",
        startedBy: { kind: "automation", id: "a1" },
        purpose: "x",
        workKey: `automation:k-${id}`,
        scope: { projectId: "p1" },
        provider: "fake",
        autonomy: "read_only",
        status,
        runnerId,
        cwd: dir,
        createdAt: ago(80),
        updatedAt: ago(1),
      } as never)
      .run();
    runs.save({
      id,
      automationId: "a1",
      projectId: "p1",
      status: "running",
      triggeredBy: "cron",
      startedBy: { kind: "automation", id: "a1" },
      purpose: "x",
      workKey: `automation:k-${id}`,
      scope: { projectId: "p1" },
      progress: null,
      skipReason: null,
      sessionId: `s-${id}`,
      startedAt: ago(80),
      finishedAt: null,
      error: null,
    } as never);
  };
  const addRunner = (id: string, state: string, lastSeenAt: string) =>
    db.db
      .insert(runners)
      .values({
        id,
        backend: "local",
        isHome: id === "home",
        runnerId: `j-${id}`,
        state,
        createdAt: ago(200),
        lastSeenAt,
      } as never)
      .run();

  /** Log a `session.updated` for the session with `status` at `ts` (as the projector would). */
  const logStatus = (id: string, status: string, ts: string) =>
    db.db
      .insert(events)
      .values({
        type: "session.updated",
        sessionId: `s-${id}`,
        payload: { session: { id: `s-${id}`, status } },
        ts,
      } as never)
      .run();

  it("expires a run interrupted 72h ago even though later writes touched the session", () => {
    addRun("r1", "interrupted");
    logStatus("r1", "running", ago(80));
    logStatus("r1", "interrupted", ago(72));
    logStatus("r1", "interrupted", ago(1)); // a generated title
    expect(runs.stranded(now).map((r) => r.id)).toEqual(["r1"]);
  });

  it("dates a session that waited a long time from the interruption, not its last agent work", () => {
    addRun("waited", "interrupted");
    logStatus("waited", "waiting", ago(50)); // waiting on an approval for 50h
    logStatus("waited", "interrupted", ago(0.1)); // the runner drained just now
    expect(runs.stranded(now)).toEqual([]);
  });

  it("restarts the clock when a session resumes and is interrupted again", () => {
    addRun("again", "interrupted");
    logStatus("again", "interrupted", ago(72));
    logStatus("again", "running", ago(70));
    logStatus("again", "interrupted", ago(2));
    expect(runs.stranded(now)).toEqual([]);
  });

  it("expires a running session whose runner has been disconnected past the limit", () => {
    addRunner("gone", "disconnected", ago(30));
    addRunner("blip", "disconnected", ago(1));
    addRunner("up", "connected", ago(100));
    addRun("on-gone", "running", "j-gone");
    addRun("on-blip", "running", "j-blip");
    addRun("on-up", "running", "j-up");
    addRun("waiting-gone", "waiting", "j-gone");
    expect(
      runs
        .stranded(now)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["on-gone", "waiting-gone"]);
  });

  it("settles a runner-gone session so a queued run behind it starts to drain", () => {
    addRunner("gone", "disconnected", ago(30));
    addRun("on-gone", "running", "j-gone");
    const repo = new SessionRepo(db.db, new EventStore(db.db));
    const executor = new AutomationExecutor({
      now: () => now,
      runs,
      repo,
    } as unknown as ExecutorDeps);
    executor.expireStrandedRuns(now);
    expect(runs.find("on-gone")?.status).toBe("failed");
    // Interrupted is not an active session status, so it no longer blocks its work key.
    expect(repo.get("s-on-gone").status).toBe("interrupted");
    expect(repo.activeWork("p1").map((w) => String(w))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("s-on-gone")]),
    );
  });
});
