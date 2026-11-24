import type { FactoryItem, FactoryTuning } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  earnedAutoMergeStatus,
  hasEarnedAutoMerge,
  isCleanFirstPassMerge,
} from "../src/services/factory/earned-auto-merge";
import { mayAutoMerge } from "../src/services/factory/trust";

const NOW = new Date("2026-11-20T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

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
  type: "bug",
  classification: null,
  trust: "trusted",
  author: null,
  admittedBy: null,
  investigation: null,
  specApproval: null,
  issue: null,
  pr: null,
  builderSessionId: "s-build",
  builderProvider: "claude",
  reviewerSessionId: "s-rev",
  reviewerProvider: "codex",
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
  mergeSha: "abc1234",
  mergePath: "fast",
  revertOf: null,
  triageRequestedAt: null,
  nudges: {},
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  sessionIds: [],
  itemBudgetSince: null,
  stepSince: null,
  createdAt: ago(10),
  updatedAt: ago(1),
  mergedAt: ago(1),
  finishedAt: null,
};

const makeItem = (id: string, patch: Partial<FactoryItem> = {}): FactoryItem => ({
  ...base,
  id,
  ...patch,
});

describe("isCleanFirstPassMerge", () => {
  it("passes for merged items with 0 attempts, no reverts, and no spot problems", () => {
    expect(isCleanFirstPassMerge(makeItem("1"))).toBe(true);
    expect(
      isCleanFirstPassMerge(
        makeItem("2", {
          spotCheck: {
            state: "looks_good",
            reason: "sampled",
            sampledAt: ago(2),
            checkedAt: ago(1),
            note: "looks good",
            issue: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("fails if attempts > 0", () => {
    expect(isCleanFirstPassMerge(makeItem("1", { attempts: 1 }))).toBe(false);
  });

  it("fails if reverted", () => {
    expect(isCleanFirstPassMerge(makeItem("1", { nudges: { reverted_at: ago(1) } }))).toBe(false);
  });

  it("fails if spot check found a problem", () => {
    expect(
      isCleanFirstPassMerge(
        makeItem("1", {
          spotCheck: {
            state: "problem",
            reason: "sampled",
            sampledAt: ago(2),
            checkedAt: ago(1),
            note: "broken",
            issue: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("fails if not merged", () => {
    expect(isCleanFirstPassMerge(makeItem("1", { stage: "failed", mergedAt: null }))).toBe(false);
  });
});

describe("hasEarnedAutoMerge", () => {
  it("requires at least N items in history", () => {
    const items = [
      makeItem("1", { type: "bug", mergedAt: ago(1) }),
      makeItem("2", { type: "bug", mergedAt: ago(2) }),
    ];
    expect(hasEarnedAutoMerge("bug", items, 3)).toBe(false);
    expect(earnedAutoMergeStatus("bug", items, 3)).toEqual({
      earned: false,
      count: 2,
      required: 3,
    });
  });

  it("earns auto-merge once N items pass cleanly", () => {
    const items = [
      makeItem("1", { type: "docs", mergedAt: ago(1) }),
      makeItem("2", { type: "docs", mergedAt: ago(2) }),
      makeItem("3", { type: "docs", mergedAt: ago(3) }),
    ];
    expect(hasEarnedAutoMerge("docs", items, 3)).toBe(true);
    expect(earnedAutoMergeStatus("docs", items, 3)).toEqual({
      earned: true,
      count: 3,
      required: 3,
    });
  });

  it("breaks the streak if the most recent item had revise rounds", () => {
    const items = [
      makeItem("1", { type: "bug", mergedAt: ago(1), attempts: 1 }),
      makeItem("2", { type: "bug", mergedAt: ago(2) }),
      makeItem("3", { type: "bug", mergedAt: ago(3) }),
      makeItem("4", { type: "bug", mergedAt: ago(4) }),
    ];
    expect(hasEarnedAutoMerge("bug", items, 3)).toBe(false);
    expect(earnedAutoMergeStatus("bug", items, 3).count).toBe(0);
  });

  it("breaks the streak if any of the last N was reverted", () => {
    const items = [
      makeItem("1", { type: "bug", mergedAt: ago(1) }),
      makeItem("2", { type: "bug", mergedAt: ago(2), nudges: { reverted_at: ago(2) } }),
      makeItem("3", { type: "bug", mergedAt: ago(3) }),
      makeItem("4", { type: "bug", mergedAt: ago(4) }),
    ];
    expect(hasEarnedAutoMerge("bug", items, 3)).toBe(false);
  });

  it("breaks the streak if any of the last N had a spot problem", () => {
    const items = [
      makeItem("1", { type: "bug", mergedAt: ago(1) }),
      makeItem("2", { type: "bug", mergedAt: ago(2) }),
      makeItem("3", {
        type: "bug",
        mergedAt: ago(3),
        spotCheck: {
          state: "problem",
          reason: "sampled",
          sampledAt: ago(3),
          checkedAt: ago(2),
          note: "bug",
          issue: null,
        },
      }),
    ];
    expect(hasEarnedAutoMerge("bug", items, 3)).toBe(false);
  });

  it("clears a broken streak once N fresh clean merges land", () => {
    const items = [
      makeItem("1", { type: "bug", mergedAt: ago(1) }),
      makeItem("2", { type: "bug", mergedAt: ago(2) }),
      makeItem("3", { type: "bug", mergedAt: ago(3) }),
      makeItem("4", { type: "bug", mergedAt: ago(4), attempts: 2 }), // older than the last 3
    ];
    expect(hasEarnedAutoMerge("bug", items, 3)).toBe(true);
  });

  it("ignores items of other kinds", () => {
    const items = [
      makeItem("1", { type: "docs", mergedAt: ago(1) }),
      makeItem("2", { type: "docs", mergedAt: ago(2) }),
      makeItem("3", { type: "docs", mergedAt: ago(3) }),
      makeItem("4", { type: "bug", mergedAt: ago(4) }),
    ];
    expect(hasEarnedAutoMerge("docs", items, 3)).toBe(true);
    expect(hasEarnedAutoMerge("bug", items, 3)).toBe(false);
  });

  it("ignores infrastructure failures and reverts in the count", () => {
    const items = [
      makeItem("1", { type: "bug", mergedAt: ago(1) }),
      makeItem("2", { type: "bug", source: "revert", mergedAt: ago(2) }), // revert ignored
      makeItem("3", {
        type: "bug",
        stage: "failed",
        failureKind: "infrastructure",
        finishedAt: ago(3),
      }), // infra ignored
      makeItem("4", { type: "bug", mergedAt: ago(4) }),
      makeItem("5", { type: "bug", mergedAt: ago(5) }),
    ];
    expect(hasEarnedAutoMerge("bug", items, 3)).toBe(true);
  });
});

describe("mayAutoMerge with earned auto-merge", () => {
  const limitsOn = { autoMerge: true };
  const limitsOff = { autoMerge: false };

  it("behaves as single switch when earnedAutoMerge is false", () => {
    const tuning: Pick<FactoryTuning, "earnedAutoMerge" | "autoMergeKinds" | "earnedStreak"> = {
      earnedAutoMerge: false,
      autoMergeKinds: { docs: "earned", bug: "earned", feature: "off" },
      earnedStreak: 5,
    };
    expect(mayAutoMerge({ trust: "trusted", type: "feature" }, limitsOn, tuning)).toBe(true);
    expect(mayAutoMerge({ trust: "trusted", type: "bug" }, limitsOn, tuning)).toBe(true);
    expect(mayAutoMerge({ trust: "trusted", type: "feature" }, limitsOff, tuning)).toBe(false);
    expect(mayAutoMerge({ trust: "admitted", type: "feature" }, limitsOn, tuning)).toBe(false);
  });

  it("defaults features to off when earnedAutoMerge is true", () => {
    const tuning: Pick<FactoryTuning, "earnedAutoMerge" | "autoMergeKinds" | "earnedStreak"> = {
      earnedAutoMerge: true,
      autoMergeKinds: { docs: "earned", bug: "earned", feature: "off" },
      earnedStreak: 3,
    };
    const items = [
      makeItem("1", { type: "feature", mergedAt: ago(1) }),
      makeItem("2", { type: "feature", mergedAt: ago(2) }),
      makeItem("3", { type: "feature", mergedAt: ago(3) }),
    ];
    // Feature stays with owner by default even if streak exists
    expect(mayAutoMerge({ trust: "trusted", type: "feature" }, limitsOn, tuning, items)).toBe(
      false,
    );
  });

  it("allows features to auto-merge if explicitly set to earned and streak is met", () => {
    const tuning: Pick<FactoryTuning, "earnedAutoMerge" | "autoMergeKinds" | "earnedStreak"> = {
      earnedAutoMerge: true,
      autoMergeKinds: { docs: "earned", bug: "earned", feature: "earned" },
      earnedStreak: 3,
    };
    const items = [
      makeItem("1", { type: "feature", mergedAt: ago(1) }),
      makeItem("2", { type: "feature", mergedAt: ago(2) }),
      makeItem("3", { type: "feature", mergedAt: ago(3) }),
    ];
    expect(mayAutoMerge({ trust: "trusted", type: "feature" }, limitsOn, tuning, items)).toBe(true);
  });

  it("allows kinds set to always to auto-merge without history", () => {
    const tuning: Pick<FactoryTuning, "earnedAutoMerge" | "autoMergeKinds" | "earnedStreak"> = {
      earnedAutoMerge: true,
      autoMergeKinds: { docs: "always", bug: "earned", feature: "off" },
      earnedStreak: 5,
    };
    expect(mayAutoMerge({ trust: "trusted", type: "docs" }, limitsOn, tuning, [])).toBe(true);
  });

  it("withholds auto-merge for earned kinds until streak is satisfied", () => {
    const tuning: Pick<FactoryTuning, "earnedAutoMerge" | "autoMergeKinds" | "earnedStreak"> = {
      earnedAutoMerge: true,
      autoMergeKinds: { docs: "earned", bug: "earned", feature: "off" },
      earnedStreak: 2,
    };
    expect(mayAutoMerge({ trust: "trusted", type: "bug" }, limitsOn, tuning, [])).toBe(false);
    expect(
      mayAutoMerge({ trust: "trusted", type: "bug" }, limitsOn, tuning, [
        makeItem("1", { type: "bug", mergedAt: ago(1) }),
      ]),
    ).toBe(false);
    expect(
      mayAutoMerge({ trust: "trusted", type: "bug" }, limitsOn, tuning, [
        makeItem("1", { type: "bug", mergedAt: ago(1) }),
        makeItem("2", { type: "bug", mergedAt: ago(2) }),
      ]),
    ).toBe(true);
  });

  it("always allows reverts to auto-merge when limits.autoMerge is true", () => {
    const tuning: Pick<FactoryTuning, "earnedAutoMerge" | "autoMergeKinds" | "earnedStreak"> = {
      earnedAutoMerge: true,
      autoMergeKinds: { docs: "off", bug: "off", feature: "off" },
      earnedStreak: 5,
    };
    expect(
      mayAutoMerge({ trust: "trusted", type: "bug", source: "revert" }, limitsOn, tuning, []),
    ).toBe(true);
  });
});

describe("scorecard earned streaks (#51)", () => {
  it("reports each kind's streak against the project's required run", async () => {
    const { buildScorecard } = await import("../src/services/factory/scorecard");
    const merged = (n: number, type: FactoryItem["type"], attempts = 0): FactoryItem => ({
      ...base,
      id: `s${type}${n}`,
      type,
      attempts,
      mergedAt: ago(24 * 60 + n),
      finishedAt: ago(24 * 60 + n),
    });
    // Old enough to fall outside the 30-day window, so the table is empty but the streak counts.
    const items = [
      ...[1, 2, 3].map((n) => merged(n, "bug")),
      merged(4, "bug", 1),
      ...[1, 2].map((n) => merged(n, "docs")),
    ];
    const ctx = {
      now: () => NOW,
      repo: { modelsOf: () => new Map() },
      projects: { get: () => ({ factoryLimits: {} }) },
      store: {
        items: () => items,
        loopOrNew: () => ({ tuning: { earnedStreak: 3 } }),
      },
    } as never;
    const card = await buildScorecard(ctx, "p1", 30);
    expect(card.earned).toEqual({
      docs: { count: 2, required: 3, earned: false },
      bug: { count: 3, required: 3, earned: true },
      feature: { count: 0, required: 3, earned: false },
    });
  });
});
