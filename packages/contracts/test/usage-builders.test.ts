import { describe, expect, it } from "vitest";
import {
  BUILDER_SCORE_MIN_CHANGES,
  BuilderScore,
  BuilderScoreQuery,
  type BuilderScoreRow,
} from "../src";
import { ts } from "./fixtures";

const row: BuilderScoreRow = {
  key: "cursor:composer-2.5",
  provider: "cursor",
  model: "composer-2.5",
  finished: 6,
  merged: 5,
  failed: 1,
  firstPass: 3,
  reviseRounds: 4,
  reverted: 1,
  inProgress: 2,
  costUsd: 12.5,
  costPerMergeUsd: 2.5,
  estimatedUsd: 1,
  unpricedTurns: 0,
  apiEquivalent: true,
  tooFew: false,
};

describe("builder score (#196)", () => {
  it("reads the window and project from the query string, 30 days by default", () => {
    expect(BuilderScoreQuery.parse({})).toEqual({ days: 30 });
    expect(BuilderScoreQuery.parse({ days: "90", projectId: "p1" })).toEqual({
      days: 90,
      projectId: "p1",
    });
    for (const days of ["0", "14", "365", "abc", ""]) {
      expect(BuilderScoreQuery.safeParse({ days }).success).toBe(false);
    }
  });

  it("round-trips a response", () => {
    const score = {
      days: 30,
      since: ts,
      minChanges: BUILDER_SCORE_MIN_CHANGES,
      finished: 6,
      inProgress: 2,
      rows: [row, { ...row, key: "claude:-", provider: "claude", model: null, tooFew: true }],
    };
    expect(BuilderScore.parse(JSON.parse(JSON.stringify(score)))).toEqual(score);
  });
});
