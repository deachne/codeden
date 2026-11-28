import type { BuilderScoreRow } from "@codeden/contracts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  costPerChange,
  costPerChangeTitle,
  passedFirstTime,
  reviewRounds,
} from "@/components/usage/builder-score";
import { BuilderScoreTable } from "@/components/usage/builder-score-table";
import { renderWithClient } from "./utils";

/** The builder score on the Usage page (#196). */

const row = (patch: Partial<BuilderScoreRow> = {}): BuilderScoreRow => ({
  key: "k",
  provider: "cursor",
  model: "composer-2.5",
  finished: 8,
  merged: 6,
  failed: 2,
  firstPass: 4,
  reviseRounds: 6,
  reverted: 1,
  inProgress: 0,
  costUsd: 12,
  costPerMergeUsd: 2,
  estimatedUsd: 0,
  unpricedTurns: 0,
  apiEquivalent: false,
  tooFew: false,
  ...patch,
});

describe("the builder score's figures (#196)", () => {
  it("reads rates over the finished changes, and none when there are too few", () => {
    expect(passedFirstTime(row())).toBe("50%");
    expect(reviewRounds(row())).toBe("0.8");
    const few = row({ finished: 2, merged: 2, failed: 0, firstPass: 2, tooFew: true });
    expect(passedFirstTime(few)).toBe("—");
    expect(reviewRounds(few)).toBe("—");
  });

  it("never shows unpriced work as $0.00", () => {
    expect(costPerChange(row({ costUsd: 12, costPerMergeUsd: 2 }))).toBe("$2.00");
    expect(costPerChange(row({ estimatedUsd: 12 }))).toBe("≈ $2.00");
    expect(costPerChange(row({ costUsd: 0, costPerMergeUsd: 0, unpricedTurns: 3 }))).toBe(
      "Not priced",
    );
    expect(costPerChange(row({ unpricedTurns: 2 }))).toBe("at least $2.00");
    expect(costPerChange(row({ costUsd: 0, costPerMergeUsd: 0 }))).toBe("No cost recorded");
    expect(costPerChange(row({ merged: 0, costPerMergeUsd: null }))).toBe("—");
    expect(costPerChangeTitle(row({ apiEquivalent: true, unpricedTurns: 2 }))).toBe(
      "API-equivalent cost per merged change, failed changes included: $12.00 over 8 changes · 2 turns not priced",
    );
  });
});

describe("the builder score table (#196)", () => {
  it("shows each builder model, with a too-few note, unpriced cost and in-progress work", async () => {
    // The mock client's sample: a model with enough changes, one not priced, one with too few.
    renderWithClient(<BuilderScoreTable />);
    const rows = await screen.findAllByTestId("builder-score-row");
    expect(rows).toHaveLength(3);
    const text = rows.map((r) => r.textContent ?? "");
    expect(text.filter((t) => t.includes("Too few to judge"))).toHaveLength(1);
    expect(text.some((t) => t.includes("Not priced"))).toBe(true);
    expect(text.some((t) => t.includes("2 in progress"))).toBe(true);
    expect(text.some((t) => t.includes("$0.00"))).toBe(false);
    expect(
      within(screen.getByTestId("builder-score-table")).getByText("Passed review first time"),
    ).toBeTruthy();
  });
});
