import {
  type FactoryItem,
  FactoryScorecard,
  REVIEWER_SCORE_MIN_REVIEWS,
  type ReviewerQualityRow,
  ReviewVerdict,
} from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { items as itemRows } from "../src/db/schema";
import type { LedgerTurn } from "../src/services/factory/item-cost";
import { bugSources, referencedNumbers } from "../src/services/factory/later-problems";
import {
  type ReviewSessionFact,
  reviewerQuality,
  unreviewedWhy,
} from "../src/services/factory/reviewer-quality";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * The reviewer scorecard (#213): per reviewer model, reviews that ended without a verdict, what the
 * review step cost, bugs filed later against what it approved, the bugs that name no source, and
 * merges that had no real review.
 */

const NOW = new Date("2026-11-28T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const approve = ReviewVerdict.parse(APPROVE);

const base: FactoryItem = {
  id: "i0",
  projectId: "p1",
  workKey: "issue:1",
  title: "Work",
  summary: "",
  source: "issue",
  area: null,
  acceptanceCriteria: [],
  score: null,
  stage: "merged",
  type: "feature",
  classification: null,
  trust: "trusted",
  author: null,
  admittedBy: null,
  investigation: null,
  specApproval: null,
  issue: null,
  pr: null,
  builderSessionId: "b",
  builderProvider: "claude",
  reviewerSessionId: null,
  reviewerProvider: null,
  reviewerNote: null,
  review: null,
  lessonsNote: null,
  followUps: [],
  spotCheck: null,
  checks: [],
  attempts: 0,
  reason: null,
  stop: null,
  failureKind: null,
  rebuiltFrom: null,
  note: null,
  mergeSha: null,
  mergePath: "current",
  revertOf: null,
  triageRequestedAt: null,
  nudges: {},
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  sessionIds: [],
  itemBudgetSince: null,
  stepSince: null,
  createdAt: ago(60),
  updatedAt: ago(1),
  mergedAt: null,
  finishedAt: null,
};
const ref = (n: number) => ({
  number: n,
  url: `https://github.com/acme/app/issues/${n}`,
  title: "t",
});
const pr = (n: number) =>
  ({
    number: n,
    url: `https://github.com/acme/app/pull/${n}`,
    state: "merged",
  }) as FactoryItem["pr"];

/** Work merged `hours` ago, approved by reviewer session `by`, with its issue and pull request. */
const approved = (id: string, issue: number, prNumber: number, hours: number, by: string) => ({
  ...base,
  id,
  title: `Work ${id}`,
  issue: ref(issue),
  pr: pr(prNumber),
  reviewerSessionId: by,
  reviewerProvider: by.startsWith("r-claude") ? "claude" : "cursor",
  review: approve,
  mergedAt: ago(hours),
  finishedAt: ago(hours),
});

/** A bug filed `hours` ago by the scout (or as `patch` says). */
const bug = (id: string, summary: string, hours: number, patch: Partial<FactoryItem> = {}) => ({
  ...base,
  id,
  title: `Bug ${id}`,
  summary,
  source: "discovery" as const,
  type: "bug" as const,
  stage: "backlog" as const,
  builderProvider: null,
  issue: ref(900 + id.length + hours),
  createdAt: ago(hours),
  ...patch,
});

const fakeSession = (id: string, provider: string, model: string | null, status = "idle") =>
  ({ id, provider, model, status }) as ReviewSessionFact["session"];
const review = (id: string, provider: string, model: string | null, submitted = true) => ({
  session: fakeSession(id, provider, model),
  submitted,
});

const opus = "claude-opus-4-5";
const turn = (sessionId: string, usd: number, over: Partial<LedgerTurn> = {}): LedgerTurn => ({
  sessionId,
  provider: "claude",
  ts: ago(2),
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd,
  costSource: "estimated",
  ...over,
});

const rowOf = (rows: ReviewerQualityRow[], provider: string, model: string | null) =>
  rows.find((r) => r.reviewer.provider === provider && r.reviewer.model === model);

describe("what a bug says it came from (#213)", () => {
  it("reads #N and pull or issue links, and ignores the rest", () => {
    expect([
      ...referencedNumbers(
        "Broke after #184 and https://github.com/acme/app/pull/202; not &#39; or abc#7 or v1.2",
      ),
    ]).toEqual([184, 202]);
  });
});

describe("the reviewer scorecard over scripted history (#213)", () => {
  // Two reviewer models on the claude and cursor providers, six and five reviews each.
  const reviews = [
    ...[1, 2, 3, 4, 5, 6].map((n) => review(`r-claude-${n}`, "claude", opus)),
    ...[1, 2, 3, 4, 5].map((n) => review(`r-cursor-${n}`, "cursor", "composer-2", n <= 2)),
    // A model with two reviews only; one still running and one idle on an item still verifying.
    review("r-codex-1", "codex", "gpt-5.5"),
    review("r-codex-2", "codex", "gpt-5.5"),
    { session: fakeSession("r-run", "claude", opus, "running"), submitted: false },
    { session: fakeSession("r-wait", "claude", opus, "idle"), submitted: false },
  ];
  const models = new Map<string, string | null>([
    ["r-claude-1", opus],
    ["r-claude-2", opus],
    ["r-claude-3", opus],
    ["r-claude-4", opus],
    ["r-cursor-1", "composer-2"],
  ]);
  const turns = new Map<string, LedgerTurn[]>();
  for (const n of [1, 2, 3, 4, 5, 6]) turns.set(`r-claude-${n}`, [turn(`r-claude-${n}`, 0.5)]);
  // Cursor reported no price: its turns have tokens and no cost.
  for (const n of [1, 2, 3, 4, 5]) {
    const id = `r-cursor-${n}`;
    turns.set(id, [turn(id, 0, { provider: "cursor", costSource: "unpriced" })]);
  }
  turns.set("r-run", [turn("r-run", 9)]);
  const history: FactoryItem[] = [
    approved("a", 184, 190, 40, "r-claude-1"),
    approved("b", 198, 199, 30, "r-claude-2"),
    approved("c", 197, 202, 20, "r-cursor-1"),
    approved("d", 150, 151, 10, "r-claude-3"),
    // Merged long before the window: a bug can name it, but it's not part of this window.
    { ...approved("old", 10, 11, 24 * 100, "r-claude-4") },
    // Reviewer still waited for on an item that is verifying.
    {
      ...base,
      id: "v",
      stage: "verifying",
      reviewerSessionId: "r-wait",
      builderProvider: "claude",
    },
    // One problem on a, two bugs on it; c has one; b has a bug that names two merges (unlinked).
    bug("bug1", "The counter broke after #184 merged", 25),
    bug("bug2", "A second break in the #184 counter", 15),
    bug("bug3", "Regression of https://github.com/acme/app/pull/202", 12),
    bug("bug4", "Names #199 and also #190: which one is it?", 11),
    bug("bug5", "Something is wrong, no source named", 9),
    // Not charged and not unlinked.
    bug("bug6", "Follow-up of #184 <!-- codeden:factory follow-up item=a -->", 25),
    bug("bug7", "Rejected report about #198", 14, { stage: "rejected" }),
    bug("bug8", "Filed before the merge, about #184", 45),
    bug("bug9", "About the old change #10", 5),
    bug("bug10", "A feature note naming #184", 5, { type: "feature" }),
  ];
  const facts = { reviews, models, turns, billing: { claude: "subscription" as const } };
  const card = reviewerQuality(history, facts, NOW, 30);

  it("charges later bugs to the model that approved, and counts the rest as unlinked", () => {
    const claude = rowOf(card.rows, "claude", opus);
    expect(claude).toMatchObject({
      reviews: 6,
      noVerdict: 0,
      approvals: 3,
      approvalsWithProblems: 1,
      laterProblems: 2,
      tooFew: false,
    });
    expect(rowOf(card.rows, "cursor", "composer-2")).toMatchObject({
      approvals: 1,
      approvalsWithProblems: 1,
      laterProblems: 1,
    });
    // bug4 names two merged items and bug5 none: unlinked, never guessed.
    expect(card.unlinkedBugs).toBe(2);
  });

  it("counts a review that ended without a verdict for its own model, not running ones", () => {
    expect(rowOf(card.rows, "cursor", "composer-2")).toMatchObject({
      reviews: 5,
      noVerdict: 3,
    });
    // The running and the awaited sessions aren't reviews yet.
    expect(rowOf(card.rows, "claude", opus)?.reviews).toBe(6);
  });

  it("prices only the review step, and says nothing priced as unknown, never $0.00", () => {
    const claude = rowOf(card.rows, "claude", opus);
    expect(claude).toMatchObject({
      costUsd: 3,
      costPerReviewUsd: 0.5,
      estimatedUsd: 3,
      apiEquivalent: true,
    });
    const cursor = rowOf(card.rows, "cursor", "composer-2");
    expect(cursor).toMatchObject({ costUsd: 0, costPerReviewUsd: null, unpricedTurns: 5 });
  });

  it("says too few to judge below the bar, and orders by reviews", () => {
    expect(card.minReviews).toBe(REVIEWER_SCORE_MIN_REVIEWS);
    expect(rowOf(card.rows, "codex", "gpt-5.5")).toMatchObject({ reviews: 2, tooFew: true });
    expect(rowOf(card.rows, "cursor", "composer-2")?.tooFew).toBe(false);
    expect(card.rows.map((r) => r.reviewer.provider)).toEqual(["claude", "cursor", "codex"]);
  });

  it("says where a bug came from only when it was filed after that work merged", () => {
    const sources = bugSources(history);
    const kinds = Object.fromEntries([...sources].map(([id, s]) => [id, s.kind]));
    expect(kinds).toEqual({
      bug1: "linked",
      bug2: "linked",
      bug3: "linked",
      bug4: "unlinked",
      bug5: "unlinked",
      // A follow-up (the reviewer's own finding), a rejected report and a feature aren't looked at.
      bug8: "notLater",
      bug9: "linked",
    });
  });

  it("answers the same on any window, and nothing when nothing finished", () => {
    const empty = reviewerQuality([], { ...facts, reviews: [] }, NOW, 7);
    expect(empty).toEqual({
      minReviews: REVIEWER_SCORE_MIN_REVIEWS,
      rows: [],
      unlinkedBugs: 0,
      unreviewedMerges: [],
    });
  });
});

describe("merges that had no real review (#213)", () => {
  const merged = (id: string, patch: Partial<FactoryItem>): FactoryItem => ({
    ...base,
    id,
    title: `Change ${id}`,
    mergePath: null,
    mergedAt: ago(Number(id.slice(1))),
    finishedAt: ago(Number(id.slice(1))),
    ...patch,
  });
  const check = (state: "fail" | "skipped" | "pending") => ({
    name: "review" as const,
    state,
    detail: null,
    escalate: false,
    at: ago(1),
  });

  it("lists a person's merge with no approving verdict, and why", () => {
    const history = [
      // A person merged while the review failed (like the three database changes).
      merged("m1", { issue: ref(185), pr: pr(190), checks: [check("fail")] }),
      merged("m2", { review: { ...approve, verdict: "request_changes" } }),
      merged("m3", { checks: [check("skipped")] }),
      merged("m4", { checks: [check("pending")] }),
      // Not listed: a docs change the docs pipeline merges unreviewed, an approved change a person
      // merged, and one the factory merged itself.
      merged("m5", { type: "docs", checks: [check("skipped")] }),
      merged("m6", { review: approve, reviewerProvider: "claude" }),
      merged("m7", { review: approve, mergePath: "current" }),
      // Outside the window.
      merged("m8", { mergedAt: ago(24 * 60), finishedAt: ago(24 * 60) }),
    ];
    const card = reviewerQuality(
      history,
      { reviews: [], models: new Map(), turns: new Map(), billing: {} },
      NOW,
      30,
    );
    expect(card.unreviewedMerges.map((m) => [m.itemId, m.why])).toEqual([
      ["m1", "failed"],
      ["m2", "failed"],
      ["m3", "skipped"],
      ["m4", "no_verdict"],
    ]);
    expect(card.unreviewedMerges[0]).toMatchObject({ issueNumber: 185, prNumber: 190 });
    expect(unreviewedWhy(history[5] as FactoryItem)).toBeNull();
  });
});

describe("the reviewer scorecard over the store, sessions and ledger (#213)", () => {
  let env: FactoryEnv;
  afterEach(() => env?.close());
  const { enable, backlogItem } = factorySteps(() => env);

  async function session(workKey: string, provider: string, model: string | null, status = "idle") {
    const res = await env.sessions.start({
      projectId: env.project.id,
      role: "agent",
      startedBy: FACTORY_STARTER,
      workKey,
      provider,
    } as Parameters<FactoryEnv["sessions"]["start"]>[0]);
    if (res.status !== "started") throw new Error("not started");
    env.repo.update(res.sessionId, (s) => ({ ...s, model, status: status as typeof s.status }));
    return res.sessionId;
  }

  /** The tool call a reviewer makes to send its verdict, as a provider records it. */
  function submitted(
    sessionId: string,
    opts: { error?: { message: string }; status?: "in_progress" | "failed" | "completed" } = {},
  ) {
    const { error, status = "completed" } = opts;
    const at = new Date().toISOString();
    env.db.db
      .insert(itemRows)
      .values({
        sessionId,
        id: `call-${sessionId}-${error ? "error" : status}`,
        threadId: "t",
        turnId: "turn",
        position: 1,
        kind: "tool_call",
        status,
        data: {
          id: `call-${sessionId}`,
          kind: "tool_call",
          status,
          toolKind: "mcp",
          toolName: "mcp__codeden__factory_submit_review",
          server: "codeden",
          tool: "factory_submit_review",
          ...(error ? { error } : {}),
        },
        createdAt: at,
        updatedAt: at,
      })
      .run();
  }

  it("reads verdicts, no-verdict reviews, cost and later bugs from the recorded data", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex"] });
    await enable();
    const feature = backlogItem("Add a counter", 7);
    const builder = await session("issue:7", "claude", opus);
    // Claude approved; the first Codex review ended without a verdict ("Upgrade your plan"), and a
    // fresh one never got to call the tool either, so the item went on with Claude.
    const approver = await session(`factory:review:${feature.id}`, "claude", opus);
    const broken = await session(`factory:review:${feature.id}`, "codex", "gpt-5.5");
    const refused = await session(`factory:review:${feature.id}`, "codex", "gpt-5.5");
    const running = await session(`factory:review:${feature.id}`, "claude", opus, "running");
    const cutOff = await session(`factory:review:${feature.id}`, "codex", "gpt-5.5");
    const failedCall = await session(`factory:review:${feature.id}`, "codex", "gpt-5.5");
    // A refused verdict (the call failed) isn't a verdict; the next call is.
    submitted(refused, { error: { message: "approve can't list security concerns" } });
    // A call cut off or failed without an error object isn't a verdict either.
    submitted(cutOff, { status: "in_progress" });
    submitted(failedCall, { status: "failed" });
    submitted(approver);
    env.spendOn(approver, 0.4);
    env.spendOn(broken, 0, { tokens: 50, costSource: "unpriced" });
    env.spendOn(running, 7);
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    env.factory.data.updateItem(feature.id, (i) => ({
      ...i,
      stage: "merged",
      builderSessionId: builder,
      builderProvider: "claude",
      reviewerSessionId: approver,
      reviewerProvider: "claude",
      review: approve,
      mergePath: "current",
      mergedAt,
      finishedAt: mergedAt,
    }));
    // A person merged this one on GitHub; its review never gave a verdict.
    const personMerged = env.factory.data.createItem({
      projectId: env.project.id,
      workKey: "issue:40",
      title: "Add a history table",
      summary: "A new table",
      source: "issue",
      stage: "merged",
      type: "feature",
      builderProvider: "claude",
      mergedAt,
      finishedAt: mergedAt,
    });
    env.factory.data.createItem({
      projectId: env.project.id,
      workKey: "issue:30",
      title: "The counter breaks",
      summary: "Counting twice since #7 was merged",
      source: "discovery",
      stage: "backlog",
      type: "bug",
      issue: {
        number: 30,
        url: "https://github.com/acme/app/issues/30",
        title: "The counter breaks",
      },
    });
    env.factory.data.createItem({
      projectId: env.project.id,
      workKey: "issue:31",
      title: "Something else",
      summary: "Nothing says where this came from",
      source: "issue",
      stage: "backlog",
      type: "bug",
      issue: { number: 31, url: "https://github.com/acme/app/issues/31", title: "Something else" },
    });

    const card = await env.factory.scorecard(env.project.id, 30);
    expect(FactoryScorecard.parse(card)).toEqual(card);
    const quality = card.reviewQuality;
    expect(quality?.rows).toEqual([
      expect.objectContaining({
        reviewer: { provider: "codex", model: "gpt-5.5" },
        // The refused, cut-off and failed calls and the one with no call: none is a verdict.
        reviews: 4,
        noVerdict: 4,
        approvals: 0,
        costPerReviewUsd: null,
        unpricedTurns: 1,
        tooFew: true,
      }),
      expect.objectContaining({
        reviewer: { provider: "claude", model: opus },
        reviews: 1,
        noVerdict: 0,
        approvals: 1,
        approvalsWithProblems: 1,
        laterProblems: 1,
        costUsd: 0.4,
        costPerReviewUsd: 0.4,
        tooFew: true,
      }),
    ]);
    expect(quality?.unlinkedBugs).toBe(1);
    expect(quality?.unreviewedMerges).toEqual([
      expect.objectContaining({ itemId: personMerged.id, why: "no_verdict", prNumber: null }),
    ]);
  });
});
