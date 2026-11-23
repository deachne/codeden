import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { runners, sessions } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { RunStore } from "../src/services/automations/runs";
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
        role: "worker",
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

  it("dates the interruption from the last agent activity, not later session writes", () => {
    addRun("old", "interrupted");
    addRun("fresh", "interrupted");
    const store = new EventStore(db.db);
    store.append([{ type: "agent.turn.started", sessionId: "s-fresh", payload: {} }] as never);
    // Both sessions' updatedAt is 1h old (a title write); only the one with no recent agent work expires.
    expect(runs.stranded(now).map((r) => r.id)).toEqual(["old"]);
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

  it("expires a run interrupted 72h ago even though a title write touched the session 1h ago", () => {
    db.db
      .insert(sessions)
      .values({
        id: "s1",
        role: "worker",
        startedBy: { kind: "automation", id: "a1" },
        purpose: "x",
        workKey: "automation:k1",
        scope: { projectId: "p1" },
        provider: "fake",
        autonomy: "read_only",
        status: "interrupted",
        cwd: dir,
        createdAt: ago(80),
        updatedAt: ago(72),
      } as never)
      .run();
    runs.save({
      id: "r1",
      automationId: "a1",
      projectId: "p1",
      status: "running",
      triggeredBy: "cron",
      startedBy: { kind: "automation", id: "a1" },
      purpose: "x",
      workKey: "automation:k1",
      scope: { projectId: "p1" },
      progress: null,
      skipReason: null,
      sessionId: "s1",
      startedAt: ago(80),
      finishedAt: null,
      error: null,
    } as never);
    expect(runs.stranded(now).map((r) => r.id)).toEqual(["r1"]);
    // A generated title (any later write) refreshes updatedAt but is not a resume.
    db.db
      .update(sessions)
      .set({ title: "A title", updatedAt: ago(1) })
      .where(eq(sessions.id, "s1"))
      .run();
    expect(runs.stranded(now).map((r) => r.id)).toEqual(["r1"]);
  });
});
