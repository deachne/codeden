import { describe, expect, it } from "vitest";
import {
  BUILDER_SCORE_MIN_CHANGES,
  FactoryScorecard,
  FactoryScorecardQuery,
  type FactoryScorecardRow,
  REVIEWER_SCORE_MIN_REVIEWS,
  ReviewerQuality,
  SCORECARD_WINDOWS,
} from "../src";
import { ts } from "./fixtures";

const row: FactoryScorecardRow = {
  key: "codex:gpt-5.5|claude:-",
  builder: { provider: "codex", model: "gpt-5.5" },
  reviewer: { provider: "claude", model: null },
  finished: 5,
  merged: 4,
  failed: 1,
  firstPass: 3,
  reviseRounds: 2,
  reverted: 1,
  medianMergeMs: 5_400_000,
  costUsd: 21.5,
  costPerMergeUsd: 5.375,
  estimatedUsd: 1.25,
  unpricedTurns: 0,
  apiEquivalent: true,
  spotChecked: 2,
  spotProblems: 1,
};

describe("factory scorecard (#361)", () => {
  it("reads the window from the query string, 30 days by default", () => {
    expect(FactoryScorecardQuery.parse({})).toEqual({ days: 30 });
    for (const days of SCORECARD_WINDOWS) {
      expect(FactoryScorecardQuery.parse({ days: String(days) })).toEqual({ days });
    }
    for (const days of ["0", "14", "365", "abc", "30.5", ""]) {
      expect(FactoryScorecardQuery.safeParse({ days }).success).toBe(false);
    }
  });

  it("round-trips a scorecard", () => {
    const card: FactoryScorecard = {
      projectId: "p1",
      days: 30,
      since: ts,
      finished: 5,
      builders: [{ ...row, key: "codex:gpt-5.5", reviewer: null }],
      reviewers: [{ ...row, key: "claude:-", builder: null }],
      pairs: [row, { ...row, key: "codex:gpt-5.5|none", reviewer: null, merged: 0, firstPass: 0 }],
      earned: {
        docs: { count: 5, required: 5, earned: true },
        bug: { count: 4, required: 5, earned: false },
        feature: { count: 0, required: 5, earned: false },
      },
    };
    expect(FactoryScorecard.parse(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it("reads rows from before spot-checks as none checked (#380)", () => {
    const { spotChecked: _c, spotProblems: _p, ...old } = row;
    const card = { projectId: "p1", days: 30, since: ts, finished: 5, builders: [old] };
    const parsed = FactoryScorecard.parse({ ...card, reviewers: [], pairs: [] });
    expect(parsed.builders[0]).toMatchObject({ spotChecked: 0, spotProblems: 0 });
    expect(
      FactoryScorecard.safeParse({
        ...card,
        builders: [{ ...row, spotProblems: -1 }],
        reviewers: [],
        pairs: [],
      }).success,
    ).toBe(false);
  });

  it("round-trips the reviewer check, and reads older responses without it (#213)", () => {
    const card = { projectId: "p1", days: 30, since: ts, finished: 0, builders: [], pairs: [] };
    expect(FactoryScorecard.parse({ ...card, reviewers: [] }).reviewQuality).toBeUndefined();
    const quality: ReviewerQuality = {
      minReviews: REVIEWER_SCORE_MIN_REVIEWS,
      rows: [
        {
          key: '["cursor","composer-2"]',
          reviewer: { provider: "cursor", model: "composer-2" },
          reviews: 33,
          noVerdict: 15,
          approvals: 12,
          approvalsWithProblems: 3,
          laterProblems: 4,
          costUsd: 0,
          costPerReviewUsd: null,
          estimatedUsd: 0,
          unpricedTurns: 3,
          apiEquivalent: false,
          tooFew: false,
        },
      ],
      unlinkedBugs: 2,
      unreviewedMerges: [
        {
          itemId: "i1",
          title: "Add a history table",
          issueNumber: 185,
          prNumber: null,
          mergedAt: ts,
          why: "failed",
        },
      ],
    };
    const full = { ...card, reviewers: [], reviewQuality: quality };
    expect(FactoryScorecard.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
    // The bar is the builder score's.
    expect(REVIEWER_SCORE_MIN_REVIEWS).toBe(BUILDER_SCORE_MIN_CHANGES);
    expect(
      ReviewerQuality.safeParse({
        ...quality,
        unreviewedMerges: [{ ...quality.unreviewedMerges[0], why: "forgot" }],
      }).success,
    ).toBe(false);
  });

  it("rejects figures that can't be", () => {
    const card = { projectId: "p1", days: 7, since: ts, finished: 1, builders: [], pairs: [] };
    expect(FactoryScorecard.safeParse({ ...card, reviewers: [] }).success).toBe(true);
    expect(FactoryScorecard.safeParse({ ...card, days: 14, reviewers: [] }).success).toBe(false);
    expect(
      FactoryScorecard.safeParse({ ...card, reviewers: [{ ...row, merged: -1 }] }).success,
    ).toBe(false);
    expect(
      FactoryScorecard.safeParse({
        ...card,
        reviewers: [{ ...row, builder: { provider: "codex", model: "" } }],
      }).success,
    ).toBe(false);
  });
});
