import { agentEventToNewEvent, defaultSettings, type ProviderInfo } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationService } from "../src/services/automations/automation-service";
import { handoffPlan } from "../src/services/sessions/handoff";
import { WorkerLimitSwitch } from "../src/services/sessions/worker-limit-switch";
import { SettingsStore } from "../src/settings-store";
import { sampleSession } from "./helpers";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const T = "t-root";
const RESET = "2026-11-20T14:00:00.000Z";
const target = { id: "codex", displayName: "CODEX", capabilities: {} } as ProviderInfo;
const project = { id: "p1", path: "/tmp/p1", defaultBranch: "main" } as Parameters<
  typeof handoffPlan
>[1];

describe("an automatic handoff of an automation's session", () => {
  const plan = (automatic: boolean) =>
    handoffPlan(
      { ...sampleSession, branch: "codeden/x", projectId: "p1", automationRunId: "run-1" },
      project,
      target,
      null,
      "brief",
      { provider: "codex" },
      automatic ? { fallback: { home: "claude", until: null, limited: {} } } : undefined,
    );

  it("keeps the run, so the new session's cost is the automation's", () => {
    expect(plan(true).session.automationRunId).toBe("run-1");
  });

  it("a handoff the owner asks for is no automation's", () => {
    expect(plan(false).session.automationRunId).toBeNull();
  });
});

describe("an automation run whose session hits a usage limit", () => {
  let env: GithubEnv;
  let automations: AutomationService;
  let switching: Set<string>;
  const settle = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    env = createGithubEnv();
    switching = new Set();
    automations = new AutomationService({
      db: env.db.db,
      store: env.store,
      settings: new SettingsStore(`${env.dir}/settings.json`),
      projects: { list: () => [] } as never,
      sessions: {} as never,
      repo: env.repo,
      inbox: env.inbox,
      orchestration: () => ({}) as never,
      github: {} as never,
      home: `${env.dir}/home`,
      rescanMs: 0,
      switching: (id: string) => switching.has(id),
    } as never);
  });
  afterEach(async () => {
    automations.stop();
    await env.close();
  });

  function startRun(): string {
    const session = env.addSession({ status: "running", automationRunId: "run-1" });
    automations.runs.save({
      id: "run-1",
      automationId: "a1",
      projectId: env.githubProject.id,
      status: "running",
      triggeredBy: "cron",
      startedBy: { kind: "automation", id: "a1" },
      purpose: "x",
      workKey: "automation:k",
      scope: { projectId: env.githubProject.id },
      progress: null,
      skipReason: null,
      sessionId: session.id,
      startedAt: "2026-11-20T10:00:00.000Z",
      finishedAt: null,
      error: null,
    } as never);
    automations.start();
    return session.id;
  }

  async function failAtLimit(sessionId: string): Promise<void> {
    env.store.append(
      [
        { type: "thread.started", thread: { id: T } },
        { type: "turn.started", threadId: T, turnId: "u1" },
        {
          type: "turn.failed",
          threadId: T,
          turnId: "u1",
          error: { message: "Limit", kind: "usage_limit", retryAt: RESET },
        },
      ].map((e) => agentEventToNewEvent(sessionId, e as never)),
    );
    await settle();
    await settle();
  }

  it("stays running while the limit switch decides", async () => {
    const id = startRun();
    switching.add(id);
    await failAtLimit(id);
    expect(automations.runs.get("run-1").status).toBe("running");
  });

  it("follows the work to its new session, whose end then settles the run", async () => {
    const id = startRun();
    switching.add(id);
    await failAtLimit(id);
    const next = env.addSession({ status: "starting" });
    env.repo.update(next.id, (s) => ({ ...s, automationRunId: "run-1" }));
    switching.delete(id);
    automations.sessionMoved(env.repo.get(id), env.repo.get(next.id));
    expect(automations.runs.get("run-1")).toMatchObject({ status: "running", sessionId: next.id });
    // The old session no longer settles the run; the new one does.
    env.store.append([agentEventToNewEvent(id, { type: "thread.started", thread: { id: T } })]);
    await settle();
    expect(automations.runs.get("run-1").status).toBe("running");
    env.repo.update(next.id, (s) => ({ ...s, status: "idle" }));
    await failAtLimit(next.id);
    expect(automations.runs.get("run-1").status).toBe("failed");
  });

  it("is failed, as before, when nothing is switching", async () => {
    const id = startRun();
    await failAtLimit(id);
    expect(automations.runs.get("run-1").status).toBe("failed");
  });
});

describe("WorkerLimitSwitch.claim guards", () => {
  let env: GithubEnv;
  let switched: string[];
  let sw: WorkerLimitSwitch;
  const providers = ["claude", "codex"].map(
    (id) => ({ id, displayName: id, models: [], capabilities: {} }) as unknown as ProviderInfo,
  );

  beforeEach(() => {
    env = createGithubEnv();
    switched = [];
    sw = new WorkerLimitSwitch({
      store: env.store,
      repo: env.repo,
      sessions: {
        switchProvider: async (id) => {
          switched.push(id);
          return env.addSession({ provider: "codex", status: "starting" });
        },
      },
      retries: { evaluate: () => {} },
      inbox: env.inbox,
      projects: { get: () => env.githubProject },
      settings: { get: () => defaultSettings() },
      runner: { providers: () => providers },
      timezone: () => "UTC",
    });
    sw.start();
  });
  afterEach(async () => {
    sw.stop();
    await env.close();
  });

  const limit = { message: "Limit", kind: "usage_limit", retryAt: RESET } as const;
  const failed = (turnId: string) => ({
    type: "turn.failed" as const,
    threadId: T,
    turnId,
    error: limit,
  });

  it("ignores a failed compaction, as the retry service does", async () => {
    const s = env.addSession({ provider: "claude", status: "running" });
    env.store.append(
      [
        { type: "thread.started", thread: { id: T } },
        { type: "turn.started", threadId: T, turnId: "w1" },
        { type: "turn.completed", threadId: T, turnId: "w1" },
        { type: "turn.started", threadId: T, turnId: "c1", kind: "compact" },
        failed("c1"),
      ].map((e) => agentEventToNewEvent(s.id, e as never)),
    );
    await sw.idle();
    expect(switched).toEqual([]);
    expect(sw.isSwitching(s.id)).toBe(false);
  });

  it("deals with a duplicate turn.failed once", async () => {
    const s = env.addSession({ provider: "claude", status: "running" });
    env.store.append(
      [
        { type: "thread.started", thread: { id: T } },
        { type: "turn.started", threadId: T, turnId: "w1" },
        failed("w1"),
        failed("w1"),
      ].map((e) => agentEventToNewEvent(s.id, e as never)),
    );
    await sw.idle();
    expect(switched).toEqual([s.id]);
  });
});
