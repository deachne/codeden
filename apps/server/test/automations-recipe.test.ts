import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Automation,
  type AutomationRun,
  FactoryLimits,
  type Project,
  type RecipeSteps,
  type StartSessionRequest,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { sessions } from "../src/db/schema";
import { EventStore } from "../src/events/store";
import { askedAutonomy, cappedAutonomy } from "../src/services/automations/approval";
import { AutomationService } from "../src/services/automations/automation-service";
import { InboxService } from "../src/services/inbox-service";
import { ProjectService } from "../src/services/projects/project-service";
import { SettingsStore } from "../src/settings-store";
import { removeTree } from "./support/remove-tree";

/**
 * Recipes (#194, §10): steps run in order, an "ask me" step pauses for the owner, and a restart
 * picks up at the first step that isn't done. The service runs over a real database; sessions
 * and the PM are scripted, so no agent turn happens.
 */

const THREE_STEPS: RecipeSteps = [
  { id: "build", type: "start_session", prompt: "Build it", autonomy: "read_only" },
  { id: "ok", type: "ask_owner", question: "OK to go on?" },
  { id: "ship", type: "start_session", prompt: "Finish it" },
];

describe("recipes", () => {
  let dir: string;
  let db: Database;
  let store: EventStore;
  let inbox: InboxService;
  let projects: ProjectService;
  let automations: AutomationService;
  let id: string;
  let clock = new Date("2026-11-20T10:00:00.000Z");
  /** Every session start the scripted SessionService saw, and the sessions it made. */
  let started: StartSessionRequest[];
  let made: Map<string, { status: string; result: { summary: string } | null }>;
  let pmMessages: string[];
  let mode: Project["autonomyMode"];

  const project = (): Project =>
    ({
      id: "pa",
      kind: "local",
      name: "Alpha",
      slug: "alpha",
      path: join(dir, "Alpha"),
      defaultBranch: "main",
      defaultProvider: null,
      autonomy: null,
      autonomyMode: mode,
      visionPath: ".codeden/VISION.md",
      factoryLimits: FactoryLimits.parse({}),
      killSwitch: false,
      timezone: "UTC",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    }) as Project;

  /** A service over the same database, as after a restart; sessions and the PM are scripted. */
  const service = (): AutomationService => {
    const svc = new AutomationService({
      db: db.db,
      store,
      settings: new SettingsStore(join(dir, "settings.json")),
      projects,
      sessions: {
        start: async (req: StartSessionRequest) => {
          started.push(req);
          const sessionId = `s${started.length}`;
          made.set(sessionId, { status: "running", result: null });
          return { status: "started", sessionId };
        },
      } as never,
      repo: {
        find: (sid: string) => {
          const s = made.get(sid);
          return s ? { session: { id: sid, ...s, rootThreadId: null } } : undefined;
        },
        update: (sid: string) => ({ id: sid }),
        activeWork: () => [],
      } as never,
      inbox,
      orchestration: () =>
        ({
          sendToRole: async (_role: string, _project: string, input: { text: string }) => {
            pmMessages.push(input.text);
            return { sessionId: "pm", status: "started" };
          },
        }) as never,
      github: {} as never,
      home: join(dir, "home"),
      rescanMs: 0,
      now: () => clock,
    });
    svc.sources.reload();
    return svc;
  };

  const finishSession = async (sid: string, summary = "Done") => {
    made.set(sid, { status: "idle", result: { summary } });
    await automations.recipe.poke(runId());
  };
  const runs = (): AutomationRun[] => automations.runs.list({ automationId: id });
  const runId = () => runs()[0]?.id ?? "";
  const run = () => runs()[0] as AutomationRun;
  const stepStatuses = () => run().recipe?.steps.map((s) => s.status);
  const cards = () => inbox.list({}).filter((i) => i.kind === "recipe_question");
  const create = (steps: RecipeSteps, enabled = true, createdBy: "user" | "pm" = "user") =>
    automations.definitions.create(
      { name: "Ship it", trigger: { type: "manual" }, action: { type: "recipe", steps }, enabled },
      { createdBy },
    );
  const start = (byPerson = true) => automations.run(id, { projectId: "pa" }, { byPerson });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-recipe-"));
    db = openDatabase(join(dir, "codeden.db"));
    store = new EventStore(db.db);
    inbox = new InboxService(db.db, store, () => async () => {});
    projects = new ProjectService({
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
    started = [];
    made = new Map();
    pmMessages = [];
    mode = "assisted";
    clock = new Date("2026-11-20T10:00:00.000Z");
    store.append([{ type: "project.created", sessionId: null, payload: { project: project() } }]);
    automations = service();
    id = create(THREE_STEPS).id;
  });

  afterEach(async () => {
    automations.stop();
    db.close();
    await removeTree(dir);
  });

  it("runs a session, pauses on the question, carries on after Yes and finishes", async () => {
    const res = await start();
    expect(res.status).toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0]?.input?.text).toContain("Build it");
    expect(stepStatuses()).toEqual(["running", "pending", "pending"]);

    await finishSession("s1");
    // Paused on the question: one card, the run waits and says what for, no second session yet.
    expect(stepStatuses()).toEqual(["done", "waiting", "pending"]);
    expect(run().status).toBe("running");
    expect(run().progress?.text).toBe("Waiting for your OK: OK to go on?");
    expect(started).toHaveLength(1);
    expect(cards()).toHaveLength(1);

    const answered = await automations.answerRecipeQuestion(cards()[0]?.id ?? "", "yes");
    expect(answered.item.status).toBe("resolved");
    expect(started).toHaveLength(2);
    expect(started[1]?.input?.text).toContain("Finish it");
    expect(stepStatuses()).toEqual(["done", "done", "running"]);

    await finishSession("s2");
    expect(run().status).toBe("completed");
    expect(stepStatuses()).toEqual(["done", "done", "done"]);
    expect(run().recipe?.steps[0]?.result).toBe("Done");
    expect(run().recipe?.steps[1]?.answer).toBe("yes");
  });

  it("stops on No and never starts the step after it", async () => {
    await start();
    await finishSession("s1");
    const cardId = cards()[0]?.id ?? "";
    await automations.answerRecipeQuestion(cardId, "no");
    expect(run().status).toBe("cancelled");
    expect(run().progress?.text).toBe("You said no at step 2: the recipe stopped");
    expect(stepStatuses()).toEqual(["done", "stopped", "pending"]);
    expect(started).toHaveLength(1);
    // The card is closed: it can't be answered again.
    await expect(automations.answerRecipeQuestion(cardId, "yes")).rejects.toMatchObject({
      code: "resolved",
    });
    expect(started).toHaveLength(1);
  });

  it("resumes a restarted run at the session it was on, without starting it again", async () => {
    await start();
    expect(started).toHaveLength(1);
    automations.stop();
    automations = service();
    await automations.recipe.resume();
    expect(started).toHaveLength(1);
    expect(stepStatuses()).toEqual(["running", "pending", "pending"]);
    // The session finished while the server was down: the restart carries on to the question.
    made.set("s1", { status: "idle", result: { summary: "Done" } });
    automations.stop();
    automations = service();
    await automations.recipe.resume();
    expect(started).toHaveLength(1);
    expect(stepStatuses()).toEqual(["done", "waiting", "pending"]);
    expect(cards()).toHaveLength(1);
  });

  it("resumes a run waiting on the owner without asking again, and goes on after the answer", async () => {
    await start();
    await finishSession("s1");
    const saves = store.headSeq();
    automations.stop();
    automations = service();
    await automations.recipe.resume();
    expect(cards()).toHaveLength(1);
    expect(store.headSeq()).toBe(saves);
    expect(started).toHaveLength(1);

    await automations.answerRecipeQuestion(cards()[0]?.id ?? "", "yes");
    expect(started).toHaveLength(2);
    expect(stepStatuses()).toEqual(["done", "done", "running"]);
  });

  it("starts a step that never got going after a crash once, and no finished step again", async () => {
    await start();
    await finishSession("s1");
    await automations.answerRecipeQuestion(cards()[0]?.id ?? "", "yes");
    // Crash right after the answer: the last step is marked running but has no session yet.
    const before = run();
    automations.runs.save({
      ...before,
      sessionId: null,
      recipe: {
        ...(before.recipe as NonNullable<AutomationRun["recipe"]>),
        steps: (before.recipe?.steps ?? []).map((s, i) =>
          i === 2 ? { ...s, sessionId: null } : s,
        ),
      },
    });
    started.length = 0;
    automations.stop();
    automations = service();
    await automations.recipe.resume();
    expect(started.map((s) => s.input?.text.includes("Finish it"))).toEqual([true]);
    expect(started.some((s) => s.input?.text.includes("Build it"))).toBe(false);
    // The answered question stays closed: it isn't raised again.
    expect(cards()).toHaveLength(0);
  });

  it("fails the run when its session fails, and starts nothing after it", async () => {
    await start();
    made.set("s1", { status: "failed", result: { summary: "It broke" } });
    await automations.recipe.poke(runId());
    expect(run().status).toBe("failed");
    expect(run().error?.message).toBe("It broke");
    expect(stepStatuses()).toEqual(["failed", "pending", "pending"]);
    expect(cards()).toHaveLength(0);
  });

  it("sends a message step to the PM and moves on", async () => {
    const msg = create([
      { id: "tell", type: "message_pm", message: "Heads up on {{project.name}}" },
      { id: "go", type: "start_session", prompt: "Go" },
    ]);
    id = msg.id;
    await start();
    expect(pmMessages[0]).toContain("Heads up on Alpha");
    expect(stepStatuses()).toEqual(["done", "running"]);
    expect(started).toHaveLength(1);
  });

  it("never answers for the owner in a dark factory: it stops the run and flags it", async () => {
    mode = "dark_factory";
    store.append([{ type: "project.updated", sessionId: null, payload: { project: project() } }]);
    await start();
    await finishSession("s1");
    expect(run().status).toBe("failed");
    expect(run().error?.message).toContain("nobody can be asked");
    expect(cards()).toHaveLength(0);
    const flag = inbox.list({}).find((i) => i.id === `inbox:recipe-dark:${runId()}`);
    expect(flag).toMatchObject({ priority: "high", notify: "needs_you", status: "open" });
    expect(started).toHaveLength(1);
  });

  it("starts a recipe a PM made switched off, and an edit to its steps switches it off again", () => {
    const made = create(THREE_STEPS, false, "pm");
    expect(made.enabled).toBe(false);
    expect(made.createdBy).toBe("pm");
    const on = automations.definitions.setEnabled(made.id, true);
    expect(on.approvedAutonomy).toBe("read_only");
    const edited = automations.definitions.update(
      made.id,
      {
        action: {
          type: "recipe",
          steps: [...THREE_STEPS, { id: "more", type: "start_session", prompt: "More" }],
        },
      },
      { switchOffOnChange: true },
    );
    expect(edited.enabled).toBe(false);
  });

  it("caps a step's permission level at what the owner approved", async () => {
    const steps: RecipeSteps = [
      { id: "a", type: "start_session", prompt: "A", autonomy: "supervised" },
      { id: "b", type: "start_session", prompt: "B", autonomy: "full" },
    ];
    const recipe = {
      ...(create(steps, false) as Automation),
      approvedAutonomy: "supervised" as const,
    };
    expect(askedAutonomy(recipe)).toBe("full");
    const run = { fallback: "auto" as const, on: true };
    expect(cappedAutonomy(recipe, "full", run)).toBe("supervised");
    expect(cappedAutonomy(recipe, "supervised", run)).toBe("supervised");
    // A person pressing Run now gets what the recipe asks for.
    expect(cappedAutonomy(recipe, "full", { ...run, byPerson: true })).toBe("full");

    // Run by someone else on a recipe nobody switched on: the project's own level, not "full".
    id = create([{ id: "x", type: "start_session", prompt: "X", autonomy: "full" }], false).id;
    await start(false);
    expect(started.at(-1)?.autonomy).toBeUndefined();
  });

  it("is not expired while it waits on the owner, but a session step that was cut off is", async () => {
    await start();
    await finishSession("s1");
    clock = new Date("2026-12-30T10:00:00.000Z");
    expect(automations.listRuns({}).find((r) => r.id === runId())?.status).toBe("running");

    // The inverse: a session step whose session stayed interrupted for days does expire.
    const other = create([{ id: "solo", type: "start_session", prompt: "Solo" }]);
    const old = "2026-11-01T00:00:00.000Z";
    db.db
      .insert(sessions)
      .values({
        id: "s-stuck",
        role: "worker",
        startedBy: { kind: "automation", id: other.id },
        purpose: "x",
        workKey: "automation:solo",
        scope: { projectId: "pa" },
        provider: "fake",
        autonomy: "read_only",
        status: "interrupted",
        cwd: dir,
        createdAt: old,
        updatedAt: old,
      } as never)
      .run();
    automations.runs.save({
      id: "stuck-run",
      automationId: other.id,
      projectId: "pa",
      status: "running",
      triggeredBy: "manual",
      startedBy: { kind: "automation", id: other.id },
      purpose: "x",
      workKey: "automation:solo",
      scope: { projectId: "pa" },
      progress: null,
      skipReason: null,
      sessionId: "s-stuck",
      issueNumber: null,
      recipe: {
        current: 0,
        byPerson: false,
        steps: [
          {
            stepId: "solo",
            status: "running",
            sessionId: "s-stuck",
            inboxItemId: null,
            answer: null,
            result: null,
            startedAt: old,
            finishedAt: null,
          },
        ],
      },
      startedAt: old,
      finishedAt: null,
      error: null,
    });
    const listed = automations.listRuns({});
    const stuck = listed.find((r) => r.id === "stuck-run");
    expect(stuck?.status).toBe("failed");
    expect(stuck?.recipe?.steps[0]?.status).toBe("failed");
    expect(listed.find((r) => r.id === runId())?.status).toBe("running");
  });

  it("stops the run when its question card is dismissed instead of answered", async () => {
    await start();
    await finishSession("s1");
    const card = cards()[0];
    if (!card) throw new Error("no card");
    // The service hands every closed card to the runner (here, as its event listener would).
    await automations.recipe.cardClosed(inbox.close(card, "dismissed", null));
    expect(run().status).toBe("cancelled");
    expect(started).toHaveLength(1);
  });
});
