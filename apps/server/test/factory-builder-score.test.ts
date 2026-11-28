import {
  BUILDER_SCORE_MIN_CHANGES,
  BuilderScore,
  type FactoryItem,
  type FactoryItemCost,
  type Project,
} from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { usageRoutes } from "../src/routes/usage";
import type { AppServices } from "../src/services/container";
import { builderScore } from "../src/services/factory/builder-score";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { REVERTED_AT } from "../src/services/factory/stats";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * The builder score (#196): first-pass merges, review rounds, reverts, work in flight and cost
 * per merged change by builder model, from the factory's own items.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const base = {
  id: "i0",
  projectId: "p1",
  workKey: "issue:1",
  title: "Work",
  summary: "",
  source: "issue",
  stage: "merged",
  builderSessionId: "b-composer",
  builderProvider: "cursor",
  attempts: 0,
  failureKind: null,
  nudges: {},
  createdAt: ago(5 * HOUR),
  mergedAt: null,
  finishedAt: null,
} as unknown as FactoryItem;
const item = (id: string, patch: Partial<FactoryItem>): FactoryItem => ({ ...base, id, ...patch });
const merged = (id: string, hoursAgo: number, patch: Partial<FactoryItem> = {}) =>
  item(id, { mergedAt: ago(hoursAgo * HOUR), finishedAt: ago(hoursAgo * HOUR), ...patch });
const failed = (id: string, hoursAgo: number, patch: Partial<FactoryItem> = {}) =>
  item(id, {
    stage: "failed",
    failureKind: "checks",
    finishedAt: ago(hoursAgo * HOUR),
    ...patch,
  });
const sonnet = { builderSessionId: "b-sonnet", builderProvider: "claude" };

const models = new Map<string, string | null>([
  ["b-composer", "composer-2.5"],
  ["b-sonnet", "claude-sonnet-5-5"],
]);
const cost = (usd: number, patch: Partial<FactoryItemCost> = {}): FactoryItemCost => ({
  usd,
  tokens: usd * 100_000,
  estimatedUsd: 0,
  unpricedTurns: 0,
  turns: 1,
  sessions: 1,
  apiEquivalent: false,
  cap: null,
  ...patch,
});
const rowOf = (score: BuilderScore, provider: string) =>
  score.rows.find((r) => r.provider === provider);

describe("the builder score (#196)", () => {
  it("tallies each builder model's passes, review rounds, reverts, work in flight and cost", () => {
    const items = [
      // Composer: five finished changes, so enough to judge. Two first-pass merges, one after
      // two revise rounds, one reverted, one failed.
      merged("c1", 2),
      merged("c2", 3),
      merged("c3", 4, { attempts: 2 }),
      merged("c4", 5, { nudges: { [REVERTED_AT]: ago(HOUR) } }),
      failed("c5", 6, { attempts: 1 }),
      // Two more in flight: neither a failure nor finished.
      item("c6", { stage: "building" }),
      item("c7", { stage: "verifying" }),
      // Sonnet: two merges, too few to judge.
      merged("s1", 2, sonnet),
      merged("s2", 3, { ...sonnet, attempts: 1 }),
      // Not results: dismissed, escalated, infrastructure failure, the factory's own revert,
      // never built, and a merge outside the window.
      item("x1", { stage: "rejected", finishedAt: ago(HOUR) }),
      item("x2", { stage: "escalated", finishedAt: ago(HOUR) }),
      failed("x3", 3, { failureKind: "infrastructure" }),
      merged("x4", 3, { source: "revert" }),
      item("x5", { stage: "building", builderProvider: null, builderSessionId: null }),
      merged("x6", 40 * 24),
    ];
    const costs = new Map([
      ["c1", cost(1)],
      ["c2", cost(2, { estimatedUsd: 0.5 })],
      ["c3", cost(3)],
      ["c4", cost(2)],
      ["c5", cost(4, { apiEquivalent: true })],
      ["s1", cost(0, { unpricedTurns: 3 })],
      ["s2", cost(0, { unpricedTurns: 1 })],
    ]);
    const score = builderScore(items, { models, costs }, NOW, 30);
    expect(BuilderScore.parse(score)).toEqual(score);
    expect(score).toMatchObject({
      days: 30,
      since: ago(30 * 24 * HOUR),
      minChanges: BUILDER_SCORE_MIN_CHANGES,
      finished: 7,
      inProgress: 2,
    });
    expect(score.rows.map((r) => r.model)).toEqual(["composer-2.5", "claude-sonnet-5-5"]);

    expect(rowOf(score, "cursor")).toMatchObject({
      model: "composer-2.5",
      finished: 5,
      merged: 4,
      failed: 1,
      firstPass: 2,
      reviseRounds: 3,
      reverted: 1,
      inProgress: 2,
      costUsd: 12,
      // Failures cost too: what one merge cost all told.
      costPerMergeUsd: 3,
      estimatedUsd: 0.5,
      unpricedTurns: 0,
      apiEquivalent: true,
      tooFew: false,
    });
    // Nothing priced for Sonnet's work: not $0.00 but flagged as unpriced, and too few to judge.
    expect(rowOf(score, "claude")).toMatchObject({
      finished: 2,
      merged: 2,
      firstPass: 1,
      reviseRounds: 1,
      inProgress: 0,
      costUsd: 0,
      unpricedTurns: 4,
      tooFew: true,
    });
  });

  it("shows work in flight apart from results, and a window of its own", () => {
    const items = [
      item("w1", { stage: "backlog" }),
      item("w2", { stage: "watching" }),
      merged("old", 20 * 24),
    ];
    const week = builderScore(items, { models, costs: new Map() }, NOW, 7);
    expect(week.rows).toEqual([
      expect.objectContaining({ finished: 0, merged: 0, failed: 0, inProgress: 2, tooFew: true }),
    ]);
    expect(week.rows[0]?.costPerMergeUsd).toBeNull();
    // Only the 30-day window reaches the older merge.
    expect(builderScore(items, { models, costs: new Map() }, NOW, 30).rows[0]).toMatchObject({
      finished: 1,
      inProgress: 2,
    });
    expect(builderScore([], { models, costs: new Map() }, NOW, 7)).toMatchObject({
      finished: 0,
      inProgress: 0,
      rows: [],
    });
  });

  it("reads a model it can't find as the provider's default", () => {
    const score = builderScore(
      [merged("a", 1, { builderSessionId: "gone" })],
      { models, costs: new Map() },
      NOW,
      30,
    );
    expect(score.rows[0]).toMatchObject({ provider: "cursor", model: null });
  });
});

describe("the builder score over the factory's store, sessions and ledger (#196)", () => {
  let env: FactoryEnv;
  afterEach(() => env?.close());
  const { enable } = factorySteps(() => env);

  async function session(workKey: string, provider: string, model: string | null) {
    const res = await env.sessions.start({
      projectId: env.project.id,
      role: "agent",
      startedBy: FACTORY_STARTER,
      workKey,
      provider,
    } as Parameters<FactoryEnv["sessions"]["start"]>[0]);
    if (res.status !== "started") throw new Error("not started");
    env.repo.update(res.sessionId, (s) => ({ ...s, model, status: "idle" }));
    return res.sessionId;
  }

  /** An item of `projectId` built by `builder`, finished `stage` just now. */
  function work(
    projectId: string,
    n: number,
    builder: { id: string; provider: string },
    stage: FactoryItem["stage"],
    patch: Partial<FactoryItem> = {},
  ) {
    const at = env.now().toISOString();
    const done = stage === "merged";
    const created = env.factory.data.createItem({
      projectId,
      workKey: `issue:${n}`,
      title: `Change ${n}`,
      summary: "",
      source: "issue",
      stage,
      type: "feature",
    });
    return env.factory.data.updateItem(created.id, (i) => ({
      ...i,
      builderSessionId: builder.id,
      builderProvider: builder.provider,
      mergedAt: done ? at : null,
      finishedAt: done || stage === "failed" ? at : null,
      failureKind: stage === "failed" ? "checks" : null,
      ...patch,
    }));
  }

  it("scores every active project, prices work from the ledger and filters by project", async () => {
    env = createFactoryEnv({ providers: ["claude", "cursor"] });
    await enable();
    const other = { ...env.project, id: "p-other", name: "other", slug: "other" } as Project;
    env.store.append([{ type: "project.created", sessionId: null, payload: { project: other } }]);
    const archived = { ...env.project, id: "p-old", name: "old", slug: "old" } as Project;
    env.store.append([
      { type: "project.created", sessionId: null, payload: { project: archived } },
      {
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...archived, archivedAt: env.now().toISOString() } },
      },
    ]);

    const composer = { id: await session("w:1", "cursor", "composer-2.5"), provider: "cursor" };
    const sonnet = { id: await session("w:2", "claude", "claude-sonnet-5-5"), provider: "claude" };
    // Sessions are archived once their item finished; their model is still found.
    for (const s of [composer, sonnet]) {
      env.repo.update(s.id, (r) => ({ ...r, archivedAt: env.now().toISOString() }));
    }
    work(env.project.id, 1, composer, "merged");
    work(other.id, 2, composer, "merged", { attempts: 1 });
    work(other.id, 3, composer, "failed", { attempts: 2 });
    work(env.project.id, 4, sonnet, "merged");
    work(env.project.id, 5, sonnet, "building");
    work(archived.id, 6, composer, "merged");
    env.spendOn(composer.id, 1);
    env.spendOn(sonnet.id, 0, { costSource: "unpriced", tokens: 5_000 });

    const all = await env.factory.builderScore(30);
    expect(BuilderScore.parse(all)).toEqual(all);
    expect(all.finished).toBe(4);
    expect(all.inProgress).toBe(1);
    // Composer's work spans two projects; the archived project's merge isn't counted.
    expect(all.rows.find((r) => r.model === "composer-2.5")).toMatchObject({
      provider: "cursor",
      finished: 3,
      merged: 2,
      failed: 1,
      firstPass: 1,
      reviseRounds: 3,
      tooFew: true,
    });
    // The ledger turn is the builder session's: it counts for each of its items.
    expect(all.rows.find((r) => r.model === "composer-2.5")?.costUsd).toBe(3);
    // Unpriced work stays unpriced.
    expect(all.rows.find((r) => r.model === "claude-sonnet-5-5")).toMatchObject({
      merged: 1,
      inProgress: 1,
      costUsd: 0,
      unpricedTurns: 1,
    });

    const one = await env.factory.builderScore(30, other.id);
    expect(one.finished).toBe(2);
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ merged: 1, failed: 1, firstPass: 0 });
  });
});

describe("GET /api/usage/builders (#196)", () => {
  const asked: Array<[number, string | undefined]> = [];
  const app = usageRoutes({
    factory: {
      builderScore: async (days: number, projectId?: string) => {
        asked.push([days, projectId]);
        return {
          days,
          since: NOW.toISOString(),
          minChanges: BUILDER_SCORE_MIN_CHANGES,
          finished: 0,
          inProgress: 0,
          rows: [],
        };
      },
    },
  } as unknown as AppServices);

  it("takes 7, 30 or 90 days, 30 by default, an optional project, and refuses other windows", async () => {
    for (const query of ["", "?days=7", "?days=90&projectId=p1"]) {
      const res = await app.request(`/builders${query}`);
      expect(res.status).toBe(200);
      BuilderScore.parse(await res.json());
    }
    expect(asked).toEqual([
      [30, undefined],
      [7, undefined],
      [90, "p1"],
    ]);
    expect((await app.request("/builders?days=14")).status).toBe(400);
    expect(asked).toHaveLength(3);
  });
});
