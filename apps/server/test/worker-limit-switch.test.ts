import {
  type AgentEvent,
  agentEventToNewEvent,
  defaultSettings,
  type ErrorInfo,
  PROVIDER_SWITCH_CODE,
  type Project,
  type ProviderInfo,
  type Session,
  type Settings,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickFallback } from "../src/services/orchestration/role-fallback";
import { AutoRetry } from "../src/services/sessions/auto-retry";
import { handoffPlan } from "../src/services/sessions/handoff";
import {
  canTakeOver,
  WorkerLimitSwitch,
  workerSwitchInboxId,
} from "../src/services/sessions/worker-limit-switch";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const T = "t-root";
const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const RESET = "2026-11-20T14:00:00.000Z";

function provider(id: string, caps: Partial<ProviderInfo["capabilities"]> = {}): ProviderInfo {
  return {
    id,
    displayName: id.toUpperCase(),
    models: [],
    capabilities: {
      resume: true,
      steer: true,
      interrupt: true,
      approvals: true,
      userQuestions: true,
      subagents: true,
      rollback: false,
      fork: true,
      images: true,
      planMode: true,
      reasoningEffort: true,
      mcp: true,
      skills: true,
      readOnly: true,
      ...caps,
    },
  };
}

describe("pickFallback for a worker (what the session needs, never a provider id)", () => {
  const all = [
    provider("claude"),
    provider("codex", { readOnly: false }),
    provider("gemini", { planMode: false }),
    provider("cursor"),
  ];
  const pick = (
    session: Partial<Session>,
    rest: Partial<Parameters<typeof pickFallback>[0]> = {},
  ) =>
    pickFallback({
      preferred: [],
      providers: all,
      ready: null,
      limited: { claude: RESET },
      now: NOW,
      canRun: (p) => canTakeOver({ ...sampleSession, ...session }, p),
      ...rest,
    });

  it("follows the preferred order, then the order Auto tries providers", () => {
    expect(pick({}, { preferred: ["gemini", "cursor"] })).toBe("gemini");
    expect(pick({}, { preferred: ["auto", null, undefined] })).toBeTruthy();
  });

  it("skips a provider at its own limit, one that isn't ready and one that can't run it", () => {
    expect(pick({}, { preferred: ["claude", "cursor"] })).toBe("cursor");
    expect(pick({}, { preferred: ["cursor", "gemini"], ready: new Set(["gemini"]) })).toBe(
      "gemini",
    );
    // Read-only needs native enforcement; a session still planning needs plan mode.
    expect(pick({ autonomy: "read_only" }, { preferred: ["codex", "cursor"] })).toBe("cursor");
    expect(pick({ planMode: true }, { preferred: ["gemini", "cursor"] })).toBe("cursor");
    expect(pick({}, { preferred: ["codex"] })).toBe("codex");
  });

  it("gives nothing when no provider can take over", () => {
    expect(pick({}, { ready: new Set() })).toBeNull();
    expect(
      pick({ autonomy: "read_only" }, { providers: [provider("codex", { readOnly: false })] }),
    ).toBeNull();
  });

  it("still asks the roles for read-only without `canRun`", () => {
    const roles = pickFallback({
      preferred: ["codex", "cursor"],
      providers: all,
      ready: null,
      limited: {},
      now: NOW,
    });
    expect(roles).toBe("cursor");
  });
});

describe("an automatic handoff keeps the work's starter", () => {
  const project = {
    id: "p1",
    path: "/tmp/p1",
    defaultBranch: "main",
  } as Parameters<typeof handoffPlan>[1];
  const fallback = { home: "claude", until: null, limited: { claude: RESET } };
  const plan = (patch: Partial<Session>, automatic: boolean) =>
    handoffPlan(
      { ...sampleSession, branch: "codeden/x", projectId: "p1", ...patch },
      project,
      provider("codex"),
      null,
      "brief",
      { provider: "codex" },
      automatic ? { fallback } : undefined,
    );

  it("starts the new session as the source's starter, and records the earlier one", () => {
    const factory = { kind: "pm", id: "factory" } as const;
    const auto = plan({ startedBy: factory }, true);
    expect(auto.session.startedBy).toEqual(factory);
    expect(auto.session.forkedFrom).toMatchObject({ kind: "handoff", startedBy: factory });
    expect(auto.meta.fallback).toEqual(fallback);
    // The owner's own click still makes a session of the owner's, trusted as its source.
    const manual = plan({ startedBy: factory }, false);
    expect(manual.session.startedBy).toEqual({ kind: "user" });
    expect(manual.session.forkedFrom).toMatchObject({ startedBy: factory });
    expect(manual.meta.fallback).toBeUndefined();
  });

  it("a work that was already handed off keeps its first starter", () => {
    const pm = { kind: "pm", id: "pm-1" } as const;
    const next = plan(
      {
        startedBy: { kind: "user" },
        forkedFrom: { sessionId: "s0", checkpoint: null, kind: "handoff", startedBy: pm },
      },
      true,
    );
    expect(next.session.forkedFrom?.startedBy).toEqual(pm);
  });
});

describe("WorkerLimitSwitch", () => {
  let env: GithubEnv;
  let settings: Settings;
  let ready: string[];
  let providers: ProviderInfo[];
  let switched: Array<{ id: string; provider: string; note?: string }>;
  let moved: Array<[string, string]>;
  let kept: Set<string>;
  let failSwitch: boolean;
  let retry: AutoRetry;
  let sent: string[];
  let sw: WorkerLimitSwitch;
  let project: Project;
  let hold: Promise<void> | null;
  let n = 0;

  beforeEach(() => {
    env = createGithubEnv();
    project = env.githubProject;
    hold = null;
    settings = defaultSettings();
    ready = ["claude", "codex"];
    providers = [provider("claude"), provider("codex")];
    switched = [];
    moved = [];
    kept = new Set();
    failSwitch = false;
    sent = [];
    n = 0;
    retry = new AutoRetry({
      db: env.db.db,
      store: env.store,
      repo: env.repo,
      inbox: env.inbox,
      settings: () => settings,
      send: async (id) => {
        sent.push(id);
      },
      delaysMs: [30],
      usageMarginMs: 10,
      holds: (id) => sw.isSwitching(id),
    });
    sw = new WorkerLimitSwitch({
      store: env.store,
      repo: env.repo,
      sessions: {
        switchProvider: async (id, req) => {
          await hold;
          if (failSwitch) throw new Error("runner is away");
          switched.push({ id, provider: req.provider, note: req.note });
          const from = env.repo.get(id);
          return env.addSession({
            provider: req.provider,
            startedBy: from.startedBy,
            status: "starting",
            title: "new",
          });
        },
      },
      retries: retry,
      inbox: env.inbox,
      projects: { get: () => project },
      settings: { get: () => settings },
      runner: { providers: () => providers },
      ready: async () => ready,
      keepsOwnRules: (s) => kept.has(s.id),
      moved: (from, to) => moved.push([from.id, to.id]),
      timezone: () => "UTC",
      now: () => NOW,
    });
    retry.start();
    sw.start();
  });
  afterEach(async () => {
    sw.stop();
    retry.stop();
    await env.close();
  });

  const agent = (sessionId: string, ...events: AgentEvent[]) =>
    env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
  const limit: ErrorInfo = { message: "Limit", kind: "usage_limit", retryAt: RESET };
  /** A worker on claude with one failed turn at its usage limit. */
  async function atLimit(
    patch: Partial<Session> = {},
    error: ErrorInfo = limit,
  ): Promise<{ session: Session; turnId: string }> {
    const session = env.addSession({ provider: "claude", status: "running", ...patch });
    const turnId = `u${++n}`;
    agent(session.id, { type: "thread.started", thread: { id: T } });
    agent(
      session.id,
      { type: "turn.started", threadId: T, turnId },
      { type: "turn.failed", threadId: T, turnId, error },
    );
    await sw.idle();
    return { session, turnId };
  }
  const switchNotices = (id: string) =>
    env.repo
      .rootItems(env.repo.get(id), ["notice"])
      .flatMap((i) => (i.kind === "notice" && i.code === PROVIDER_SWITCH_CODE ? [i] : []));
  const inboxItems = () => env.inbox.list().filter((i) => i.id.startsWith("inbox:provider-switch"));

  it("moves the work to the next ready provider, says so once and stops the retry", async () => {
    const { session, turnId } = await atLimit();
    expect(switched).toEqual([
      {
        id: session.id,
        provider: "codex",
        note: expect.stringContaining("Switched from CLAUDE to CODEX"),
      },
    ]);
    const [notice] = switchNotices(session.id);
    expect(notice?.message).toContain("CLAUDE hit its usage limit (until");
    expect(notice?.data).toMatchObject({ reason: "usage_limit", from: "claude", to: "codex" });
    const next = moved[0]?.[1] as string;
    expect(moved).toEqual([[session.id, next]]);
    // One note for the owner, from the failed session to the new one.
    expect(inboxItems()).toMatchObject([
      { id: workerSwitchInboxId(session.id), kind: "message", sessionId: next },
    ]);
    // The new session shows the notice once its first turn starts.
    expect(switchNotices(next)).toEqual([]);
    agent(next, { type: "thread.started", thread: { id: T } });
    agent(next, { type: "turn.started", threadId: T, turnId: "n1" });
    expect(switchNotices(next)).toHaveLength(1);
    // No pending retry, and none after a restart: the session is marked as handed over.
    expect(retry.pending()).toEqual([]);
    expect(env.repo.find(session.id)?.startMeta?.handedOffTo).toBe(next);
    retry.evaluate(session.id);
    expect(retry.pending()).toEqual([]);
    expect(sw.isSwitching(session.id)).toBe(false);
    expect(sent).toEqual([]);
    expect(env.repo.get(session.id).status).toBe("idle");
    expect(env.inbox.list().filter((i) => i.kind === "run_failed")).toEqual([]);
    expect(turnId).toBeTruthy();
    // The retry's own notice was never written for the turn that moved.
    expect(env.repo.item(session.id, `auto-retry-${turnId}`)).toBeUndefined();
  });

  it("leaves the session alone while it decides, whatever the reset time or retry setting", async () => {
    let release: () => void = () => {};
    hold = new Promise<void>((r) => {
      release = r;
    });
    for (const [retryAt, autoRetry] of [
      [undefined, true],
      [RESET, false],
      ["2026-11-20T09:00:00.000Z", true],
    ] as const) {
      settings.sessions.autoRetry = autoRetry;
      const session = env.addSession({ provider: "claude", status: "running" });
      const turnId = `h${++n}`;
      agent(session.id, { type: "thread.started", thread: { id: T } });
      agent(
        session.id,
        { type: "turn.started", threadId: T, turnId },
        { type: "turn.failed", threadId: T, turnId, error: { ...limit, retryAt } },
      );
      await Promise.resolve();
      // Neither failed (a run_failed item), nor continued with a message, mid-handoff.
      expect(sw.isSwitching(session.id)).toBe(true);
      expect(env.repo.get(session.id).status).toBe("idle");
      expect(retry.pending()).not.toContain(session.id);
    }
    expect(env.inbox.list().filter((i) => i.kind === "run_failed")).toEqual([]);
    release();
    await sw.idle();
    expect(switched).toHaveLength(3);
    for (const { id } of switched) {
      expect(env.repo.get(id).status).toBe("idle");
      expect(env.repo.find(id)?.startMeta?.handedOffTo).toBeTruthy();
    }
    expect(env.inbox.list().filter((i) => i.kind === "run_failed")).toEqual([]);
    expect(inboxItems()).toHaveLength(3);
    expect(sent).toEqual([]);
  });

  it("hands a session that doesn't move back to the retry service, with or without a reset time", async () => {
    ready = ["claude"];
    const a = await atLimit();
    expect(retry.pending()).toEqual([a.session.id]);
    // No reset time and no retry left: it fails as before, once the switch has said no.
    const b = await atLimit({}, { message: "Limit", kind: "usage_limit" });
    expect(sw.isSwitching(b.session.id)).toBe(false);
    expect(env.repo.get(b.session.id).status).toBe("failed");
    expect(env.inbox.list().filter((i) => i.kind === "run_failed")).toHaveLength(1);
    // A failed handoff does the same.
    ready = ["claude", "codex"];
    failSwitch = true;
    const c = await atLimit();
    expect(retry.pending()).toContain(c.session.id);
  });

  it("doesn't touch a session of an archived or non-git project", async () => {
    project = { ...project, archivedAt: "2026-11-01T00:00:00.000Z" };
    const archived = await atLimit();
    project = { ...env.githubProject, isGitRepo: false };
    const plain = await atLimit();
    expect(switched).toEqual([]);
    for (const { session } of [archived, plain]) {
      expect(switchNotices(session.id)).toEqual([]);
      expect(retry.pending()).toContain(session.id);
    }
  });

  it("does nothing, and the session waits for the reset, with the setting off", async () => {
    settings.providers.autoSwitchOnLimit = false;
    const { session } = await atLimit();
    expect(switched).toEqual([]);
    expect(switchNotices(session.id)).toEqual([]);
    expect(inboxItems()).toEqual([]);
    expect(retry.pending()).toEqual([session.id]);
  });

  it("switches nothing when no other provider is ready, and says why", async () => {
    ready = ["claude"];
    const { session } = await atLimit();
    expect(switched).toEqual([]);
    const [notice] = switchNotices(session.id);
    expect(notice?.data).toMatchObject({ reason: "no_fallback", to: null });
    expect(notice?.message).toContain("no other provider is ready");
    expect(inboxItems()).toEqual([]);
    expect(env.repo.find(session.id)?.startMeta?.handedOffTo).toBeUndefined();
    expect(retry.pending()).toEqual([session.id]);
  });

  it("leaves a failed handoff to the retry", async () => {
    failSwitch = true;
    const { session } = await atLimit();
    expect(switchNotices(session.id)).toEqual([]);
    expect(inboxItems()).toEqual([]);
    expect(moved).toEqual([]);
    expect(retry.pending()).toEqual([session.id]);
  });

  it("leaves other failures, other sessions and other threads alone", async () => {
    await atLimit({}, { message: "Overloaded", kind: "transient", retryable: true });
    const kept1 = env.addSession({ provider: "claude", status: "running" });
    kept.add(kept1.id);
    agent(kept1.id, { type: "thread.started", thread: { id: T } });
    agent(
      kept1.id,
      { type: "turn.started", threadId: T, turnId: "k1" },
      { type: "turn.failed", threadId: T, turnId: "k1", error: limit },
    );
    // A role session, and a failure in a thread that isn't the root one.
    await atLimit({ role: "pm" });
    const other = env.addSession({ provider: "claude", status: "running" });
    agent(other.id, { type: "thread.started", thread: { id: T } });
    agent(
      other.id,
      { type: "turn.started", threadId: "sub", turnId: "x1" },
      { type: "turn.failed", threadId: "sub", turnId: "x1", error: limit },
    );
    await sw.idle();
    expect(switched).toEqual([]);
    // Sessions that can't be handed off (no branch yet) wait as before.
    await atLimit({ branch: null });
    expect(switched).toEqual([]);
  });

  it("never moves the work back onto a provider that is at its own limit", async () => {
    providers = [provider("claude"), provider("codex"), provider("cursor")];
    ready = ["claude", "codex", "cursor"];
    const first = await atLimit();
    expect(switched[0]?.provider).toBe("codex");
    // The codex session records where it came from; its own limit then picks a third provider.
    const second = env.addSession({
      provider: "codex",
      status: "running",
    });
    env.repo.setStartMeta(second.id, (m) => ({
      ...(m as NonNullable<typeof m>),
      fallback: { home: "claude", until: RESET, limited: { claude: RESET } },
    }));
    agent(second.id, { type: "thread.started", thread: { id: T } });
    agent(
      second.id,
      { type: "turn.started", threadId: T, turnId: "c1" },
      { type: "turn.failed", threadId: T, turnId: "c1", error: limit },
    );
    await sw.idle();
    expect(switched.map((s) => s.provider)).toEqual(["codex", "cursor"]);
    expect(first.session.id).not.toBe(second.id);
  });
});

describe("the factory and a worker that moved", () => {
  let env: FactoryEnv;
  afterEach(() => env?.close());

  it("follows a builder without a PR to its new session, and leaves the rest to the factory", async () => {
    env = createFactoryEnv();
    const { item, tick, enable, backlogItem, openPr } = factorySteps(() => env);
    enable("software_factory");
    const created = backlogItem();
    await tick();
    const builderId = item(created.id).builderSessionId as string;
    const builder = env.repo.get(builderId);
    expect(env.factory.keepsOwnLimitRules(builder)).toBe(false);

    const next = { ...builder, id: "moved-1", provider: "codex" } as Session;
    const before = item(created.id);
    env.factory.builderMoved(builder, next);
    const after = item(created.id);
    expect(after.builderSessionId).toBe("moved-1");
    expect(after.builderProvider).toBe("codex");
    expect(after.earlierSessionIds).toContain(builderId);
    // A switch is no failed attempt and no revise round.
    expect(after.attempts).toBe(before.attempts);
    expect(after.nudges).toEqual(before.nudges);
    expect(after.stage).toBe(before.stage);

    // Once the PR exists, or for anything but a builder, the factory's own rules apply.
    env.factory.builderMoved(next, builder);
    await openPr(created.id);
    await tick();
    const reviewer = env.repo.get(item(created.id).reviewerSessionId as string);
    expect(env.factory.keepsOwnLimitRules(reviewer)).toBe(true);
    const current = env.repo.get(item(created.id).builderSessionId as string);
    expect(item(created.id).pr).not.toBeNull();
    expect(env.factory.keepsOwnLimitRules(current)).toBe(true);
    expect(env.factory.keepsOwnLimitRules({ ...sampleSession, startedBy: { kind: "user" } })).toBe(
      false,
    );
  });

  it("doesn't nudge or fail a builder while its work is being moved", async () => {
    env = createFactoryEnv();
    const { item, tick, enable, backlogItem } = factorySteps(() => env);
    enable("software_factory");
    const created = backlogItem();
    await tick();
    const builderId = item(created.id).builderSessionId as string;
    await env.setStatus(builderId, "idle");
    const sent = () => env.messages.filter((m) => m.sessionId === builderId).length;
    const before = sent();
    env.switching.add(builderId);
    await tick();
    await tick();
    expect(sent()).toBe(before);
    expect(item(created.id)).toMatchObject({ stage: "building", builderSessionId: builderId });
    // Once the switch is over, the builder is treated as before.
    env.switching.clear();
    await tick();
    expect(sent()).toBeGreaterThan(before);
  });
});
