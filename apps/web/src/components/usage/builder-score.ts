import type { BuilderScoreRow } from "@codeden/contracts";
import { money, percent } from "./format";

/**
 * The builder score's figures as the Usage page shows them (§12.6): plain-word rates with the
 * same honest cost labels as the usage reports. A model with too few finished changes gets no
 * rates, so a small number never reads as a confident percentage.
 */

/** "Too few to judge" with how many it takes; the table shows it beside the count. */
export function tooFewText(row: BuilderScoreRow, minChanges: number): string {
  return `Too few to judge (${row.finished} of ${minChanges} needed)`;
}

/** Share of the finished changes that merged with no revise round ("67%"); "—" when too few. */
export function passedFirstTime(row: BuilderScoreRow): string {
  if (row.tooFew || row.finished === 0) return "—";
  return percent(row.firstPass / row.finished);
}

/** Revise rounds per finished change ("0.8"); "—" when too few. */
export function reviewRounds(row: BuilderScoreRow): string {
  if (row.tooFew || row.finished === 0) return "—";
  return (row.reviseRounds / row.finished).toFixed(1);
}

/**
 * Cost per merged change: "≈ $4.10" estimated, "$4.10" reported, "at least $4.10" when some turns
 * had no price, "Not priced" when none did, "—" without a merge. Never "$0.00" for work that
 * simply wasn't priced.
 */
export function costPerChange(row: BuilderScoreRow): string {
  if (row.costPerMergeUsd === null) return "—";
  if (row.costUsd === 0) return row.unpricedTurns > 0 ? "Not priced" : "No cost recorded";
  const text = money(row.costPerMergeUsd, row.estimatedUsd > 0);
  return row.unpricedTurns > 0 ? `at least ${text}` : text;
}

/** What the cost is: "API-equivalent cost per merged change, failures included: $12.00 over 5 changes · 2 turns not priced". */
export function costPerChangeTitle(row: BuilderScoreRow): string {
  const kind = row.apiEquivalent
    ? "API-equivalent cost per merged change"
    : "Cost per merged change";
  const estimated = row.estimatedUsd > 0 ? " (estimated from list prices)" : "";
  const changes = `${row.finished} change${row.finished === 1 ? "" : "s"}`;
  const notPriced = row.costUsd === 0 && row.unpricedTurns > 0;
  const figure = notPriced
    ? `Not priced over ${changes}`
    : `${money(row.costUsd, row.estimatedUsd > 0)} over ${changes}`;
  return [
    `${kind}, failed changes included${estimated}: ${figure}`,
    row.unpricedTurns > 0
      ? `${row.unpricedTurns} turn${row.unpricedTurns === 1 ? "" : "s"} not priced`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
