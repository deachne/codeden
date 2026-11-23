import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { sessions } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { RunStore } from "../src/services/automations/runs";
import { removeTree } from "./support/remove-tree";

/** A run whose session stays interrupted (its runner never came back) must free its cap slot. */
describe("RunStore.activeCount with a session that never resumed", () => {
  let dir: string;
  let db: Database;
  let runs: RunStore;
  const hour = 3600_000;
  const now = new Date("2026-11-10T12:00:00.000Z");

  const addRun = (id: string, sessionStatus: string, sessionUpdatedAt: string) => {
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
        status: sessionStatus,
        cwd: dir,
        createdAt: sessionUpdatedAt,
        updatedAt: sessionUpdatedAt,
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
      startedAt: sessionUpdatedAt,
      finishedAt: null,
      error: null,
    } as never);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-stranded-"));
    db = openDatabase(join(dir, "codeden.db"));
    runs = new RunStore(db.db, new EventStore(db.db));
  });
  afterEach(() => {
    db.close();
    removeTree(dir);
  });

  it("counts a recently interrupted run but not one interrupted for days", () => {
    addRun("recent", "interrupted", new Date(now.getTime() - hour).toISOString());
    addRun("stuck", "interrupted", new Date(now.getTime() - 72 * hour).toISOString());
    addRun("live", "running", new Date(now.getTime() - 72 * hour).toISOString());
    // The days-old interrupted run no longer holds a slot; the other two do.
    expect(runs.activeCount("a1", "p1", now)).toBe(2);
  });
});
