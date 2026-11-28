import type { ReviewerQuality, ReviewerQualityRow } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  costPerReview,
  costPerReviewTitle,
  noVerdictRate,
  problemsLater,
  unlinkedText,
  unreviewedLabel,
} from "@/components/factory/reviewer-quality";
import { ScorecardCard } from "@/components/factory/scorecard-card";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/** The reviewer check on the factory scorecard (#213), in plain words. */

const row = (patch: Partial<ReviewerQualityRow> = {}): ReviewerQualityRow => ({
  key: "k",
  reviewer: { provider: "cursor", model: "composer-2" },
  reviews: 33,
  noVerdict: 9,
  approvals: 12,
  approvalsWithProblems: 3,
  laterProblems: 4,
  costUsd: 0,
  costPerReviewUsd: null,
  estimatedUsd: 0,
  unpricedTurns: 3,
  apiEquivalent: false,
  tooFew: false,
  ...patch,
});

describe("the reviewer check's figures (#213)", () => {
  it("reads rates, problems and cost in plain words", () => {
    expect(noVerdictRate(row())).toBe("27%");
    expect(problemsLater(row())).toBe("3 of 12");
    expect(problemsLater(row({ approvals: 0 }))).toBe("—");
    // Nothing priced is "Not priced", never $0.00; an estimate shows as one.
    expect(costPerReview(row())).toBe("Not priced");
    expect(costPerReview(row({ costPerReviewUsd: 0.42, estimatedUsd: 5 }))).toBe("≈ $0.42");
  });

  it("never says $0.00 on hover either when nothing was priced", () => {
    expect(costPerReviewTitle(row())).toBe(
      "Cost per review: not priced over 33 reviews · 3 turns not priced",
    );
    expect(costPerReviewTitle(row({ costPerReviewUsd: 0.42, costUsd: 4.2, reviews: 10 }))).toBe(
      "Cost per review: $4.20 over 10 reviews · 3 turns not priced",
    );
  });

  it("names unlinked bugs and merges without a real review", () => {
    const quality = (unlinkedBugs: number): ReviewerQuality => ({
      minReviews: 5,
      rows: [],
      unlinkedBugs,
      unreviewedMerges: [],
    });
    expect(unlinkedText(quality(0))).toBeNull();
    expect(unlinkedText(quality(2))).toContain("2 bugs filed in this window didn't say");
    expect(
      unreviewedLabel({
        itemId: "i",
        title: "Add a history table",
        issueNumber: 185,
        prNumber: 190,
        mergedAt: "2026-11-28T10:00:00.000Z",
        why: "no_verdict",
      }),
    ).toBe("Add a history table (#190): merged by a person while its review never gave a verdict");
  });
});

describe("the reviewer check on the scorecard (#213)", () => {
  const open = () => {
    const details = screen.getByTestId("factory-scorecard") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
  };

  it("shows each reviewer model, and 'Too few to judge' without percentages", async () => {
    renderWithClient(<ScorecardCard projectId="p-storefront" />, createMockClient());
    open();
    await waitFor(() => expect(screen.getAllByTestId("factory-reviewer-row").length).toBe(3));
    const rows = screen.getAllByTestId("factory-reviewer-row");
    const cursor = rows.find((r) => r.textContent?.includes("composer-2")) as HTMLElement;
    // The demo's broken reviewer: many reviews with no verdict, and nothing priced.
    expect(cursor.textContent).toContain("27%");
    expect(cursor.textContent).toContain("Not priced");
    const few = rows.find((r) => r.textContent?.includes("Too few to judge")) as HTMLElement;
    expect(few.textContent).not.toContain("%");
    const check = screen.getByTestId("factory-reviewer-check");
    expect(within(check).getByTestId("factory-unlinked-bugs").textContent).toContain("Unlinked");
    expect(within(check).getByTestId("factory-unreviewed-merges").textContent).toContain(
      "merged by a person",
    );
  });
});
