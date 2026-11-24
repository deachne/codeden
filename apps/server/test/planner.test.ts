import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_OWNER_CHECKS,
  PLANNER_WORK_KEY,
  type Project,
  type Session,
  Settings,
  type StartedBy,
  type StartSessionRequest,
  type StartSessionResponse,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import type { ServerToolContext } from "../src/mcp/define";
import { proposePlan } from "../src/mcp/tools/planner";
import type { AppServices } from "../src/services/container";
import { badRequest } from "../src/services/errors";
import { runTool } from "../src/services/exec";
import { writeVision } from "../src/services/factory/vision";
import { readPlan, writePlan } from "../src/services/projects/plan-file";
import { plannerBrief, startPlanner } from "../src/services/projects/planner";
import { ProjectService } from "../src/services/projects/project-service";
import { removeTree } from "./support/remove-tree";

// §8.5 The Planner: "Plan with me" starts it, and `propose_plan` is its hand-off.

let dir: string;
let database: Database;
let projects: ProjectService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-planner-"));
  database = openDatabase(join(dir, "codeden.db"));
  projects = new ProjectService({
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

async function addProject(): Promise<Project> {
  const folder = join(dir, "app");
  mkdirSync(folder, { recursive: true });
  return (await projects.create({ source: { type: "local", path: folder } })).project;
}

function session(project: Project, over: Partial<Session> = {}): Session {
  return {
    id: "s-planner",
    projectId: project.id,
    role: "agent",
    workKey: PLANNER_WORK_KEY,
    startedBy: { kind: "user" },
    archivedAt: null,
    ...over,
  } as Session;
}

/** `startPlanner` with scripted sessions and settings. */
function planner(opts: { open?: Session[]; settings?: unknown; readOnly?: boolean } = {}) {
  const starts: StartSessionRequest[] = [];
  const deps = {
    projects,
    repo: { list: () => opts.open ?? [] },
    settings: { get: () => Settings.parse(opts.settings ?? {}) },
    sessions: {
      start: async (req: StartSessionRequest): Promise<StartSessionResponse> => {
        starts.push(req);
        if (req.autonomy === "read_only" && opts.readOnly === false) {
          throw badRequest("This provider can't run read-only", "read_only_unsupported");
        }
        return { status: "started", sessionId: "s-new" };
      },
    },
  };
  return { starts, start: (projectId: string) => startPlanner(deps, projectId) };
}

/** `propose_plan` as a session calls it; vision and plan are saved locally, as in a local project. */
function proposeAs(project: Project, caller: Session, existingChecks: string[] = []) {
  const checks = existingChecks.map((text) => ({ text }));
  const services = {
    projects,
    sessionRepo: { find: (id: string) => (id === caller.id ? { session: caller } : undefined) },
    factory: {
      putVision: async (id: string, contents: string) => writeVision(projects.get(id), contents),
      putPlan: async (id: string, contents: string) => writePlan(projects.get(id), contents),
      ownerChecks: () => ({ checks: [...checks] }),
      addOwnerCheck: (_id: string, text: string) => checks.push({ text }),
    },
  } as unknown as AppServices;
  const ctx = {
    services,
    sessionId: caller.id,
    projectId: project.id,
    role: "agent",
    caller: "mcp",
    signal: new AbortController().signal,
  } as ServerToolContext<"session">;
  return {
    listed: () =>
      proposePlan.isAvailable?.(services, { projectId: project.id, sessionId: caller.id }),
    checks: () => checks.map((c) => c.text),
    call: (ownerChecks: string[] = []) =>
      proposePlan.handler(
        { vision: "# Vision\n\n## Goals\n- Ship it\n", plan: "# Plan\n", ownerChecks },
        ctx,
      ),
  };
}

describe("Plan with me", () => {
  it("starts a read-only Planner the user started, on the Planner's model, with its brief", async () => {
    const project = await addProject();
    const { starts, start } = planner({
      settings: { providers: { planner: { provider: "fake", model: "fake-big", effort: "high" } } },
    });
    expect(await start(project.id)).toEqual({ sessionId: "s-new", status: "started" });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      projectId: project.id,
      role: "agent",
      provider: "fake",
      model: "fake-big",
      effort: "high",
      autonomy: "read_only",
      workKey: PLANNER_WORK_KEY,
      startedBy: { kind: "user" },
    });
    expect(starts[0]?.input?.text).toContain("propose_plan");
  });

  it("leaves the provider to the agent default on auto, and reuses the Planner already open", async () => {
    const project = await addProject();
    const fresh = planner();
    await fresh.start(project.id);
    expect(fresh.starts[0]?.provider).toBeUndefined();

    const reopened = planner({ open: [session(project, { id: "s-open" })] });
    expect(await reopened.start(project.id)).toEqual({ sessionId: "s-open", status: "existing" });
    expect(reopened.starts).toHaveLength(0);
  });

  it("still starts on a provider that can't run read-only", async () => {
    const project = await addProject();
    const { starts, start } = planner({ readOnly: false });
    expect(await start(project.id)).toMatchObject({ status: "started" });
    expect(starts.map((s) => s.autonomy)).toEqual(["read_only", undefined]);
  });

  it("briefs the Planner with the vision and plan the project has, or their templates", async () => {
    const project = await addProject();
    expect(plannerBrief(project)).toMatch(/There is no `\.codeden\/VISION\.md` yet/);
    writeVision(project, "# Vision\n\n## Goals\n- Count emoji\n");
    writePlan(project, "# Plan\n\n## First version\n- One page\n");
    const brief = plannerBrief(project);
    expect(brief).toContain("- Count emoji");
    expect(brief).toContain("- One page");
    expect(brief).toContain("one question at a time");
    expect(brief).toContain("Keep the owner's checks out of both files");
    // The plan template leaves the owner's checks to owner checks, which builders never see.
    expect(readPlan({ path: join(dir, "elsewhere") }).contents).not.toMatch(/## How the owner/);
  });
});

describe("propose_plan", () => {
  it("saves both files and leaves the plan waiting for the owner", async () => {
    const project = await addProject();
    const tool = proposeAs(project, session(project));
    expect(tool.listed()).toBe(true);
    const out = String(await tool.call());
    expect(out).toContain("Approve plan");
    expect(readFileSync(join(project.path, ".codeden", "VISION.md"), "utf8")).toContain("Ship it");
    expect(readFileSync(join(project.path, ".codeden", "PLAN.md"), "utf8")).toBe("# Plan\n");
    expect(projects.get(project.id).planStatus).toBe("awaiting_approval");
  });

  it("adds the owner's checks to owner checks, never to the files, once each and up to the cap", async () => {
    const project = await addProject();
    const tool = proposeAs(project, session(project), ["I paste a link and see a summary"]);
    const out = String(
      await tool.call(["I paste a link  and see a SUMMARY", "I can copy the summary"]),
    );
    expect(tool.checks()).toEqual(["I paste a link and see a summary", "I can copy the summary"]);
    expect(out).toContain("Owner checks: 1 added, 1 the project already had");
    for (const file of ["VISION.md", "PLAN.md"]) {
      expect(readFileSync(join(project.path, ".codeden", file), "utf8")).not.toContain("copy");
    }

    const full = proposeAs(
      project,
      session(project),
      Array.from({ length: MAX_OWNER_CHECKS - 1 }, (_, i) => `Check ${i}`),
    );
    expect(String(await full.call(["One more", "And another"]))).toContain("1 added, 1 left out");
    expect(full.checks()).toHaveLength(MAX_OWNER_CHECKS);
  });

  it("keeps an approved plan approved", async () => {
    const project = await addProject();
    projects.approvePlan(project.id);
    await proposeAs(project, session(project)).call();
    expect(projects.get(project.id).planStatus).toBe("approved");
  });

  it.each<[string, Partial<Session>]>([
    ["a PM", { startedBy: { kind: "pm", id: "pm" } as StartedBy }],
    ["the factory", { startedBy: { kind: "pm", id: "factory" } as StartedBy }],
    ["another session the user started", { workKey: "request:abc" }],
  ])("is not there for %s, and refuses if called anyway", async (_who, over) => {
    const project = await addProject();
    const tool = proposeAs(project, session(project, over));
    expect(tool.listed()).toBe(false);
    await expect(tool.call()).rejects.toThrow(/Only a Planner session/);
    expect(projects.get(project.id).planStatus).toBe("planning");
  });
});
