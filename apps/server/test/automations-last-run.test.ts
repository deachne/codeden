import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AutomationRun, FactoryLimits, type Project } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { AutomationService } from "../src/services/automations/automation-service";
import { InboxService } from "../src/services/inbox-service";
import { ProjectService } from "../src/services/projects/project-service";
import { SettingsStore } from "../src/settings-store";
import { removeTree } from "./support/remove-tree";

/** An automation that runs in several projects shows each project its own last run. */
describe("automation list: last run per project", () => {
  let dir: string;
  let db: Database;
  let automations: AutomationService;
  const id = "global:nightly";

  const project = (pid: string): Project => {
    const now = new Date().toISOString();
    return {
      id: pid,
      kind: "local",
      name: pid,
      slug: pid,
      path: join(dir, pid),
      defaultBranch: "main",
      defaultProvider: null,
      autonomy: null,
      autonomyMode: "assisted",
      visionPath: ".codeden/VISION.md",
      factoryLimits: FactoryLimits.parse({}),
      killSwitch: false,
      timezone: "UTC",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    } as Project;
  };
  const run = (runId: string, projectId: string, status: "completed" | "failed", at: string) =>
    ({
      id: runId,
      automationId: id,
      projectId,
      status,
      triggeredBy: "cron",
      startedBy: { kind: "automation", id },
      purpose: "Nightly",
      workKey: "automation:nightly",
      scope: { projectId },
      progress: null,
      skipReason: null,
      sessionId: null,
      startedAt: at,
      finishedAt: at,
      error: null,
    }) as AutomationRun;
  const lastRunIn = (projectId?: string) =>
    automations.list(projectId).automations.find((a) => a.automation.id === id)?.lastRun?.id ??
    null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-last-run-"));
    db = openDatabase(join(dir, "codeden.db"));
    const store = new EventStore(db.db);
    const projects = new ProjectService({
      db: db.db,
      store,
      exec: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        notFound: false,
        timedOut: false,
        path: null,
      }),
      projectsDir: dir,
    });
    for (const pid of ["p1", "p2", "p3"]) {
      store.append([
        { type: "project.created", sessionId: null, payload: { project: project(pid) } },
      ]);
    }
    const globalDir = join(dir, "home", "automations");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "nightly.md"),
      [
        "---",
        "name: Nightly",
        "trigger:",
        "  type: cron",
        '  expression: "0 3 * * *"',
        "  timezone: UTC",
        "action: start_session",
        "provider: fake",
        "autonomy: read_only",
        "---",
        "Summarize {{project.name}}.",
      ].join("\n"),
    );
    automations = new AutomationService({
      db: db.db,
      store,
      settings: new SettingsStore(join(dir, "settings.json")),
      projects,
      sessions: {} as never,
      repo: {} as never,
      inbox: new InboxService(db.db, store, () => async () => {}),
      orchestration: () => ({}) as never,
      github: {} as never,
      home: join(dir, "home"),
      rescanMs: 0,
    });
    automations.sources.reload();
  });

  afterEach(async () => {
    automations.stop();
    db.close();
    await removeTree(dir);
  });

  it("shows each project its own run, null where it never ran, newest overall without a filter", () => {
    automations.runs.save(run("r1", "p1", "failed", "2026-11-20T03:00:00.000Z"));
    automations.runs.save(run("r2", "p2", "completed", "2026-11-21T03:00:00.000Z"));
    expect(lastRunIn("p1")).toBe("r1");
    expect(lastRunIn("p2")).toBe("r2");
    expect(lastRunIn("p3")).toBeNull();
    expect(lastRunIn()).toBe("r2");
  });

  it("fails an old running run whose automation was deleted, keeps a live non-triage one (#146)", () => {
    const old = "2026-01-01T00:00:00.000Z";
    const gone = { ...run("gone", "p1", "completed", old), automationId: "global:deleted" };
    automations.runs.save({ ...gone, status: "running", finishedAt: null } as AutomationRun);
    automations.runs.save({
      ...run("live", "p1", "completed", old),
      status: "running",
    } as AutomationRun);
    const status = Object.fromEntries(automations.listRuns({}).map((r) => [r.id, r.status]));
    expect(status.gone).toBe("failed");
    expect(status.live).toBe("running");
  });
});
