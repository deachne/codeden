import type { ReviewerQuality, ReviewerQualityRow, UnreviewedMerge } from "@codeden/contracts";
import { money, percent } from "@/components/usage/format";

/**
 * The reviewer check on the scorecard (§10.1): per reviewer model, how many reviews ended with no
 * verdict, how many approvals had a bug filed against them later and what a review costs, in
 * plain words. A model with too few reviews gets no percentages.
 */

/** "Too few to judge": fewer reviews than the bar, so no percentages. */
export function tooFewText(row: ReviewerQualityRow, minReviews: number): string {
  return `Only ${row.reviews} review${row.reviews === 1 ? "" : "s"} in this window; it takes ${minReviews} to judge a reviewer.`;
}

/** Share of the finished reviews that ended without a verdict ("27%"); "—" with none. */
export function noVerdictRate(row: ReviewerQualityRow): string {
  return percent(row.reviews > 0 ? row.noVerdict / row.reviews : null);
}

/** "9 of 33 reviews ended without a verdict, so nothing was approved or sent back." */
export function noVerdictTitle(row: ReviewerQualityRow): string {
  const reviews = `${row.reviews} review${row.reviews === 1 ? "" : "s"}`;
  return `${row.noVerdict} of ${reviews} ended without a verdict (for example the provider ran out of plan), so nothing was approved or sent back.`;
}

/** "2 of 7" approvals with a bug filed later; "—" without approvals. */
export function problemsLater(row: ReviewerQualityRow): string {
  return row.approvals === 0 ? "—" : `${row.approvalsWithProblems} of ${row.approvals}`;
}

/** What "problems found later" counts, for this row. */
export function problemsLaterTitle(row: ReviewerQualityRow): string {
  const bugs = `${row.laterProblems} bug${row.laterProblems === 1 ? "" : "s"}`;
  return `${row.approvalsWithProblems} of ${row.approvals} approved changes had a bug filed against them later (${bugs} in all). Only bugs that name the change they came from are counted.`;
}

/** "≈ $0.42" estimated, "$0.42" reported, "Not priced" when nothing could be priced. */
export function costPerReview(row: ReviewerQualityRow): string {
  if (row.costPerReviewUsd === null) return "Not priced";
  return money(row.costPerReviewUsd, row.estimatedUsd > 0);
}

/** What the cost per review is: "API-equivalent cost per review: ≈ $4.20 over 10 reviews". */
export function costPerReviewTitle(row: ReviewerQualityRow): string {
  const kind = row.apiEquivalent ? "API-equivalent cost per review" : "Cost per review";
  const estimated = row.estimatedUsd > 0 ? " (estimated from list prices)" : "";
  const unpriced = row.unpricedTurns > 0 ? ` · ${row.unpricedTurns} turns not priced` : "";
  return `${kind}${estimated}: ${money(row.costUsd, row.estimatedUsd > 0)} over ${row.reviews} review${row.reviews === 1 ? "" : "s"}${unpriced}`;
}

/** "Bugs that don't say where they came from: 2"; null with none. */
export function unlinkedText(quality: ReviewerQuality): string | null {
  const n = quality.unlinkedBugs;
  if (n === 0) return null;
  return `${n} bug${n === 1 ? "" : "s"} filed in this window didn't say which change ${n === 1 ? "it" : "they"} came from, so ${n === 1 ? "it isn't" : "they aren't"} charged to any reviewer.`;
}

const WHY: Record<UnreviewedMerge["why"], string> = {
  failed: "its review failed",
  no_verdict: "its review never gave a verdict",
  skipped: "its review was skipped",
};

/** "Add a counter (#12): merged by a person while its review never gave a verdict". */
export function unreviewedLabel(m: UnreviewedMerge): string {
  const ref = m.prNumber ?? m.issueNumber;
  return `${m.title}${ref ? ` (#${ref})` : ""}: merged by a person while ${WHY[m.why]}`;
}
