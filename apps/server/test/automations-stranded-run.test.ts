import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomationRun } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { sessions } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { AutomationService } from "../src/services/automations/automation-service";
import { AutomationExecutor, type ExecutorDeps } from "../src/services/automations/executor";
import { RunStore } from "../src/services/automations/runs";
import { InboxService } from "../src/services/inbox-service";
import { SettingsStore } from "../src/settings-store";
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

  it("lists a long-stranded run as failed, in plain words, and leaves the others running", () => {
    addRun("stuck", "interrupted", "2020-01-01T00:00:00.000Z");
    addRun("live", "running", "2020-01-01T00:00:00.000Z");
    const store = new EventStore(db.db);
    const automations = new AutomationService({
      db: db.db,
      store,
      settings: new SettingsStore(join(dir, "settings.json")),
      projects: {} as never,
      sessions: {} as never,
      repo: {} as never,
      inbox: new InboxService(db.db, store, () => async () => {}),
      orchestration: () => ({}) as never,
      github: {} as never,
      home: join(dir, "home"),
      rescanMs: 0,
    });
    const byId = Object.fromEntries(automations.listRuns({}).map((r) => [r.id, r]));
    automations.stop();
    expect(byId.stuck?.status).toBe("failed");
    expect(byId.stuck?.error?.message).toContain("cut off and never resumed");
    expect(byId.stuck?.finishedAt).not.toBeNull();
    expect(byId.live?.status).toBe("running");
  });
});

describe("AutomationExecutor.expireStrandedRuns", () => {
  it("fails only the runs the store reports as stranded, with a plain message", () => {
    const now = new Date("2026-11-10T12:00:00.000Z");
    const saved: AutomationRun[] = [];
    const stranded = { id: "stuck", status: "running" } as AutomationRun;
    const executor = new AutomationExecutor({
      now: () => now,
      runs: {
        stranded: () => [stranded],
        save: (r: AutomationRun) => {
          saved.push(r);
          return r;
        },
      },
    } as unknown as ExecutorDeps);
    executor.expireStrandedRuns(now);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: "stuck",
      status: "failed",
      finishedAt: now.toISOString(),
    });
    expect(saved[0]?.error?.message).toContain("cut off and never resumed");
  });
});
