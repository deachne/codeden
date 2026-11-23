import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedBy } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { ServiceError } from "../src/services/errors";
import { runTool } from "../src/services/exec";
import { buildProjectStatus, renderProjectDigest } from "../src/services/orchestration/digest";
import { assertPlanAllowsStart } from "../src/services/projects/plan-approval";
import { ProjectService } from "../src/services/projects/project-service";
import { removeTree } from "./support/remove-tree";

// §8.5 Plan approval: until a person approves a new project's plan, CodeDen starts no agent
// session that a PM, the orchestrator, an automation or the factory asks for.

let dir: string;
let database: Database;
let service: ProjectService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-plan-"));
  database = openDatabase(join(dir, "codeden.db"));
  service = new ProjectService({
    db: database.db,
    store: new EventStore(database.db),
    exec: runTool,
    projectsDir: join(dir, "clones"),
  });
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

async function addProject() {
  const folder = join(dir, "app");
  mkdirSync(folder, { recursive: true });
  return (await service.create({ source: { type: "local", path: folder } })).project;
}

function refusal(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    return (error as ServiceError).code;
  }
}

describe("Plan approval", () => {
  it("starts a new project in planning, and approving records the vision and plan read", async () => {
    const project = await addProject();
    expect(project).toMatchObject({ planStatus: "planning", planApproval: null });

    const vision = "# Vision\n\n## Purpose\n\nA small app.\n";
    mkdirSync(join(project.path, ".codeden"), { recursive: true });
    writeFileSync(join(project.path, ".codeden", "VISION.md"), vision);
    const plan = "# Plan\n\n## First version\n- One page\n";
    writeFileSync(join(project.path, ".codeden", "PLAN.md"), plan);
    const approved = service.approvePlan(project.id);
    expect(approved.planStatus).toBe("approved");
    expect(approved.planApproval?.visionSha256).toBe(
      createHash("sha256").update(vision).digest("hex"),
    );
    expect(approved.planApproval?.planSha256).toBe(createHash("sha256").update(plan).digest("hex"));
    // Stored, so it survives a restart.
    expect(service.get(project.id)).toMatchObject({
      planStatus: "approved",
      planApproval: approved.planApproval,
    });
  });

  it("records no vision or plan when the project has none", async () => {
    const project = await addProject();
    expect(service.approvePlan(project.id).planApproval).toMatchObject({
      visionSha256: null,
      planSha256: null,
    });
  });

  it("refuses agent sessions nobody but a person asked for while planning", async () => {
    const project = await addProject();
    const start = (startedBy: StartedBy, role: "agent" | "pm" | "orchestrator" = "agent") =>
      refusal(() => assertPlanAllowsStart(project, { role, startedBy }));

    expect(start({ kind: "pm" })).toBe("plan_not_approved");
    expect(start({ kind: "pm", id: "factory" })).toBe("plan_not_approved");
    expect(start({ kind: "orchestrator" })).toBe("plan_not_approved");
    expect(start({ kind: "automation", id: "a1" })).toBe("plan_not_approved");
    // A person's own session, and the PM and orchestrator themselves, still start.
    expect(start({ kind: "user" })).toBeUndefined();
    expect(start({ kind: "user" }, "pm")).toBeUndefined();
    expect(start({ kind: "user" }, "orchestrator")).toBeUndefined();

    const approved = service.approvePlan(project.id);
    expect(
      refusal(() => assertPlanAllowsStart(approved, { role: "agent", startedBy: { kind: "pm" } })),
    ).toBeUndefined();
  });

  it("lets older projects, written before plan approval, run as before", async () => {
    const { planStatus: _s, planApproval: _a, ...older } = await addProject();
    const legacy = older as Parameters<typeof assertPlanAllowsStart>[0];
    expect(
      refusal(() => assertPlanAllowsStart(legacy, { role: "agent", startedBy: { kind: "pm" } })),
    ).toBeUndefined();
  });

  it("tells the PM in its status that the plan waits for the owner", async () => {
    const project = await addProject();
    const status = (p: typeof project) =>
      renderProjectDigest(
        buildProjectStatus({ project: p, work: [], scheduled: [], inbox: [], outcomes: [] }),
        Date.parse("2026-11-23T12:00:00.000Z"),
        "UTC",
      );
    expect(status(project)).toContain("Plan: being planned");
    expect(status({ ...project, planStatus: "awaiting_approval" })).toContain(
      "Plan: waiting for the owner's approval",
    );
    expect(status(service.approvePlan(project.id))).not.toContain("Plan:");
  });
});
