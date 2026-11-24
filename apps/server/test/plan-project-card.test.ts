import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planProjectInboxId } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { runTool } from "../src/services/exec";
import { InboxService } from "../src/services/inbox-service";
import { ProjectService } from "../src/services/projects/project-service";
import { removeTree } from "./support/remove-tree";

// §8.5 A project added while its plan isn't approved raises one "Plan this project?" card in the
// Inbox, which follows the plan: ready to check once handed over, resolved once approved.

let dir: string;
let database: Database;
let projects: ProjectService;
let inbox: InboxService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-plan-card-"));
  database = openDatabase(join(dir, "codeden.db"));
  const store = new EventStore(database.db);
  projects = new ProjectService({
    db: database.db,
    store,
    exec: runTool,
    projectsDir: join(dir, "clones"),
  });
  inbox = new InboxService(database.db, store, () => {
    throw new Error("no responder in this test");
  });
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

async function addProject() {
  const folder = join(dir, "app");
  mkdirSync(folder, { recursive: true });
  return (await projects.create({ source: { type: "local", path: folder } })).project;
}

const card = (projectId: string) => inbox.find(planProjectInboxId(projectId));

describe("Plan this project? card", () => {
  it("is raised with a new project, says when a plan is ready, and resolves on approval", async () => {
    const project = await addProject();
    const raised = card(project.id);
    expect(raised).toMatchObject({
      kind: "plan_project",
      status: "open",
      notify: "needs_you",
      projectId: project.id,
      title: "Plan app before agents build",
    });
    expect(raised?.body).toContain("Plan with me");

    projects.markPlanProposed(project.id);
    expect(card(project.id)).toMatchObject({
      status: "open",
      title: "A plan for app is ready for you to check",
      createdAt: raised?.createdAt,
    });

    projects.approvePlan(project.id);
    const resolved = card(project.id);
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: { by: "codeden", note: "Plan approved" },
    });
    // Approving again leaves the resolved card alone.
    projects.approvePlan(project.id);
    expect(card(project.id)).toEqual(resolved);
  });

  it("follows a rename, and a card the owner dismissed stays dismissed", async () => {
    const project = await addProject();
    projects.update(project.id, { name: "Emoji counter" });
    expect(card(project.id)?.title).toBe("Plan Emoji counter before agents build");

    const open = card(project.id);
    if (!open) throw new Error("no card");
    inbox.close(open, "dismissed", null);
    projects.markPlanProposed(project.id);
    expect(card(project.id)?.status).toBe("dismissed");
    projects.archive(project.id);
    expect(card(project.id)?.status).toBe("dismissed");
  });

  it("resolves an open card when the project is archived, and raises it again on restore", async () => {
    const project = await addProject();
    projects.archive(project.id);
    expect(card(project.id)).toMatchObject({
      status: "resolved",
      resolution: { by: "codeden", note: "Project archived" },
    });

    const restored = await addProject();
    expect(restored.id).toBe(project.id);
    expect(card(project.id)).toMatchObject({ status: "open", resolution: null });
  });

  it("isn't raised for a project whose plan is approved", async () => {
    const project = await addProject();
    projects.approvePlan(project.id);
    projects.archive(project.id);
    await addProject();
    expect(card(project.id)?.status).toBe("resolved");
  });
});
