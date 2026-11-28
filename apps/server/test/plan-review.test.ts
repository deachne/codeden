import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLANNER_WORK_KEY,
  type Project,
  type ProviderInfo,
  type Session,
  type StartSessionRequest,
  type StartSessionResponse,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import type { AnyServerTool } from "../src/mcp/define";
import { submitPlanOpinions, submitPlanReview } from "../src/mcp/tools/plan-review";
import type { AppServices } from "../src/services/container";
import { runTool } from "../src/services/exec";
import { planReviewOptions } from "../src/services/plan-review/options";
import { PlanReviewService } from "../src/services/plan-review/service";
import { PlanReviewStore } from "../src/services/plan-review/store";
import { writePlan } from "../src/services/projects/plan-file";
import { ProjectService } from "../src/services/projects/project-service";
import { removeTree } from "./support/remove-tree";

// §8.5 Second opinions on a plan: the box before Go, read-only independent reviewers, the cost
// cap, the Planner's table, and the owner's row-by-row answers.

let dir: string;
let database: Database;
let projects: ProjectService;
let events: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-plan-review-"));
  database = openDatabase(join(dir, "codeden.db"));
  events = new EventStore(database.db);
  projects = new ProjectService({
    db: database.db,
    store: events,
    exec: runTool,
    projectsDir: join(dir, "clones"),
  });
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

const info = (id: string, maker: string | undefined, readOnly = true): ProviderInfo =>
  ({
    id,
    displayName: id.toUpperCase(),
    ...(maker ? { maker } : {}),
    capabilities: { readOnly },
    models: [],
  }) as unknown as ProviderInfo;

const PROVIDERS = [
  info("claude", "Anthropic"),
  info("codex", "OpenAI"),
  info("gemini", "Google"),
  info("cursor", "Cursor"),
  info("noreadonly", "Nobody", false),
];

const ready = (...ids: string[]) =>
  PROVIDERS.map((p) => ({
    id: p.id,
    name: p.displayName,
    runnable: ids.includes(p.id),
    reason: ids.includes(p.id) ? null : "isn't signed in",
  }));

describe("planReviewOptions", () => {
  it("prefers other companies than the Planner's, ready ones first, three ticked", () => {
    const o = planReviewOptions({
      providers: PROVIDERS,
      choices: ready("claude", "codex", "gemini", "cursor"),
      plannerProvider: "claude",
    });
    expect(o.candidates.map((c) => c.providerId)).toEqual(["codex", "gemini", "cursor", "claude"]);
    expect(o.candidates.filter((c) => c.defaultOn).map((c) => c.providerId)).toEqual([
      "codex",
      "gemini",
      "cursor",
    ]);
    expect(o.candidates.at(-1)?.differentMaker).toBe(false);
  });

  it("never ticks a provider that isn't ready, and leaves out ones that can't be read-only", () => {
    const o = planReviewOptions({
      providers: PROVIDERS,
      choices: ready("claude", "gemini"),
      plannerProvider: "claude",
    });
    expect(o.candidates.map((c) => c.providerId)).toEqual(["gemini", "claude", "codex", "cursor"]);
    const codex = o.candidates.find((c) => c.providerId === "codex");
    expect(codex).toMatchObject({ ready: false, defaultOn: false, reason: "isn't signed in" });
    expect(o.candidates.some((c) => c.providerId === "noreadonly")).toBe(false);
  });
});

// ------------------------------------------------------------------ the service

interface Env {
  project: Project;
  service: PlanReviewService;
  starts: StartSessionRequest[];
  stopped: string[];
  sent: Array<{ id: string; text: string }>;
  sessions: Map<string, Session>;
  costs: Map<string, number>;
  replies: Map<string, string>;
  planner: Session;
}

async function setup(opts: { plan?: boolean; planner?: boolean } = {}): Promise<Env> {
  const folder = join(dir, "app");
  mkdirSync(folder, { recursive: true });
  const project = (await projects.create({ source: { type: "local", path: folder } })).project;
  if (opts.plan !== false) writePlan(project, "# Plan\n\n## First version\n- A thing\n");
  const planner = {
    id: "s-planner",
    projectId: project.id,
    role: "agent",
    provider: "claude",
    workKey: PLANNER_WORK_KEY,
    startedBy: { kind: "user" },
    archivedAt: null,
    status: "idle",
  } as unknown as Session;
  const sessions = new Map<string, Session>();
  if (opts.planner !== false) sessions.set(planner.id, planner);
  const starts: StartSessionRequest[] = [];
  const stopped: string[] = [];
  const sent: Env["sent"] = [];
  const costs = new Map<string, number>();
  const replies = new Map<string, string>();
  let n = 0;
  const service = new PlanReviewService({
    events,
    store: new PlanReviewStore(database.db, events),
    projects,
    repo: {
      find: (id: string) => {
        const session = sessions.get(id);
        return session ? { session } : undefined;
      },
      list: () => [...sessions.values()].filter((s) => s.workKey === PLANNER_WORK_KEY),
      turnCount: () => 1,
      rootItems: (s: Session) =>
        replies.has(s.id) ? [{ kind: "assistant_message", text: replies.get(s.id) }] : [],
    } as never,
    sessions: {
      start: async (req: StartSessionRequest): Promise<StartSessionResponse> => {
        starts.push(req);
        const id = `s-rev-${++n}`;
        sessions.set(id, { id, projectId: project.id, status: "running" } as unknown as Session);
        return { status: "started", sessionId: id };
      },
      send: async (id: string, req: { input: { text: string } }) => {
        sent.push({ id, text: req.input.text });
        return { status: "sent" };
      },
      stop: async (id: string) => {
        stopped.push(id);
        const s = sessions.get(id);
        if (s) sessions.set(id, { ...s, status: "stopped" } as Session);
        return sessions.get(id) as Session;
      },
    } as never,
    runner: { providers: () => PROVIDERS },
    choices: async () => ready("claude", "codex", "gemini", "cursor"),
    turnsOf: (ids) => [...ids].map((id) => ({ costUsd: costs.get(id) ?? 0 })),
    archive: async () => undefined,
  });
  return { project, service, starts, stopped, sent, sessions, costs, replies, planner };
}

const finish = (env: Env, id: string, status = "idle") =>
  env.sessions.set(id, { ...(env.sessions.get(id) as Session), status } as Session);

const ROW = {
  point: "The plan assumes a database that isn't there",
  raisedBy: ["CODEX"],
  stance: "agree" as const,
  call: "Add a storage choice",
  reason: "The code has no database yet",
  askOwner: false,
};

describe("Go", () => {
  it("starts nothing before Go, then one read-only session per ticked reviewer, all with one brief", async () => {
    const env = await setup();
    const options = await env.service.optionsNow(env.project.id);
    expect(options.candidates.filter((c) => c.defaultOn)).toHaveLength(3);
    expect(env.starts).toHaveLength(0);

    const review = await env.service.begin(env.project.id, {
      reviewers: ["codex", "gemini"],
      capUsd: 3,
    });
    expect(env.starts.map((s) => s.provider)).toEqual(["codex", "gemini"]);
    expect(env.starts.every((s) => s.autonomy === "read_only")).toBe(true);
    expect(env.starts.every((s) => s.startedBy.kind === "user")).toBe(true);
    expect(new Set(env.starts.map((s) => s.input?.text)).size).toBe(1);
    expect(env.starts[0]?.input?.text).toContain(
      "find gaps, risks and wrong guesses about the code",
    );
    expect(env.starts[0]?.input?.text).toContain("## First version");
    expect(review).toMatchObject({ status: "reviewing", capUsd: 3, settlerSessionId: "s-planner" });
    expect(review.reviewers.map((r) => r.providerId)).toEqual(["codex", "gemini"]);
  });

  it("is refused without a plan", async () => {
    const env = await setup({ plan: false });
    await expect(env.service.optionsNow(env.project.id)).rejects.toMatchObject({ code: "no_plan" });
    expect(env.starts).toHaveLength(0);
  });

  it("is refused without an open Planner session", async () => {
    const env = await setup({ planner: false });
    await expect(
      env.service.begin(env.project.id, { reviewers: ["codex"], capUsd: 3 }),
    ).rejects.toMatchObject({ code: "no_planner" });
    expect(env.starts).toHaveLength(0);
  });

  it("refuses an unknown or not-ready reviewer and a second review while one runs", async () => {
    const env = await setup();
    await expect(
      env.service.begin(env.project.id, { reviewers: ["noreadonly"], capUsd: 3 }),
    ).rejects.toMatchObject({ code: "unknown_provider" });
    await env.service.begin(env.project.id, { reviewers: ["codex"], capUsd: 3 });
    await expect(
      env.service.begin(env.project.id, { reviewers: ["gemini"], capUsd: 3 }),
    ).rejects.toMatchObject({ code: "plan_review_running" });
  });
});

describe("the reviews and the table", () => {
  async function started(env: Env) {
    return env.service.begin(env.project.id, {
      reviewers: ["codex", "gemini", "cursor"],
      capUsd: 3,
    });
  }

  it("stops a reviewer that goes over the cap and still asks the Planner to settle", async () => {
    const env = await setup();
    const review = await started(env);
    const [a, b, c] = review.reviewers.map((r) => r.sessionId) as [string, string, string];
    env.service.submitReview(a, "Codex says: there is no database");
    env.costs.set(b, 5); // over the $3 cap while still running
    env.replies.set(c, "Cursor says: tests are missing");
    finish(env, a);
    finish(env, c);
    await env.service.refresh();

    expect(env.stopped).toEqual([b]);
    const after = env.service.latest(env.project.id);
    expect(after?.status).toBe("settling");
    expect(after?.reviewers.map((r) => r.status)).toEqual(["done", "stopped_cap", "done"]);
    // A reviewer that never submitted a report has its last reply stand in.
    expect(after?.reviewers[2]?.text).toBe("Cursor says: tests are missing");
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.id).toBe("s-planner");
    expect(env.sent[0]?.text).toContain("Codex says: there is no database");
    expect(env.sent[0]?.text).toContain("stopped for going over its cost cap");
    expect(env.sent[0]?.text).toContain("submit_plan_opinions");
  });

  it("settles even when every reviewer failed, and a reviewer's text reaches only the Planner", async () => {
    const env = await setup();
    const review = await started(env);
    for (const r of review.reviewers) finish(env, r.sessionId, "failed");
    await env.service.refresh();
    expect(env.service.latest(env.project.id)?.status).toBe("settling");
    expect(env.sent[0]?.text).toContain("nothing came back from this reviewer");
    // No reviewer was ever sent anything after its brief.
    expect(env.sent.every((m) => m.id === "s-planner")).toBe(true);
  });

  it("keeps the table, lets the owner decide row by row, and sends only accepted rows to the Planner", async () => {
    const env = await setup();
    const review = await started(env);
    for (const r of review.reviewers) finish(env, r.sessionId);
    await env.service.refresh();
    env.service.submitOpinions("s-planner", [
      ROW,
      { ...ROW, point: "Rename the project", reason: "Cosmetic", stance: "disagree" },
      { ...ROW, point: "Who pays for hosting?", askOwner: true },
    ]);
    const table = env.service.latest(env.project.id);
    expect(table?.status).toBe("ready");
    const [r1, r2, r3] = (table?.rows ?? []) as Array<{ id: string }>;
    if (!r1 || !r2 || !r3) throw new Error("expected three rows");

    await expect(env.service.apply(env.project.id)).rejects.toMatchObject({
      code: "nothing_accepted",
    });
    env.service.decide(env.project.id, r1.id, "accepted");
    env.service.decide(env.project.id, r2.id, "rejected");
    env.service.decide(env.project.id, r3.id, "accepted");

    // The decisions are saved: a fresh read of the database has them.
    const reloaded = new PlanReviewStore(database.db, events).latest(env.project.id);
    expect(reloaded?.rows.map((r) => r.decision)).toEqual(["accepted", "rejected", "accepted"]);

    env.sent.length = 0;
    const applied = await env.service.apply(env.project.id);
    expect(applied.status).toBe("applied");
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.text).toContain("The plan assumes a database");
    expect(env.sent[0]?.text).toContain("Who pays for hosting?");
    expect(env.sent[0]?.text).not.toContain("Rename the project");
    expect(env.sent[0]?.text).toContain("propose_plan");
    // Once applied, the table can't be changed or applied again.
    await expect(env.service.apply(env.project.id)).rejects.toMatchObject({
      code: "no_plan_review",
    });
  });

  it("only lists the tools to the sessions they are for", async () => {
    const env = await setup();
    const review = await started(env);
    const services = { planReviews: env.service } as unknown as AppServices;
    const reviewer = review.reviewers[0]?.sessionId as string;
    const listed = (tool: { isAvailable?: AnyServerTool["isAvailable"] }, id: string) =>
      tool.isAvailable?.(services, { projectId: env.project.id, sessionId: id });
    expect(listed(submitPlanReview, reviewer)).toBe(true);
    expect(listed(submitPlanReview, "s-planner")).toBe(false);
    // The table waits for the reviewers: the Planner has no way to settle it yet.
    expect(listed(submitPlanOpinions, "s-planner")).toBe(false);
    expect(() => env.service.submitOpinions("s-planner", [ROW])).toThrow();
    for (const r of review.reviewers) finish(env, r.sessionId);
    await env.service.refresh();
    expect(listed(submitPlanOpinions, "s-planner")).toBe(true);
    expect(listed(submitPlanOpinions, reviewer)).toBe(false);
    expect(listed(submitPlanReview, reviewer)).toBe(false);
  });

  it("can be cancelled while reviewers work, stopping them", async () => {
    const env = await setup();
    const review = await started(env);
    const cancelled = await env.service.cancel(env.project.id);
    expect(cancelled.status).toBe("cancelled");
    expect(env.stopped).toEqual(review.reviewers.map((r) => r.sessionId));
    // A new round can start.
    await expect(
      env.service.begin(env.project.id, { reviewers: ["codex"], capUsd: 3 }),
    ).resolves.toMatchObject({ status: "reviewing" });
  });
});
