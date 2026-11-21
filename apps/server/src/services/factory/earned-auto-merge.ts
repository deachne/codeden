import type { FactoryItem, WorkType } from "@codeden/contracts";
import { isInfraFailure } from "./recover";
import { revertedAt } from "./stats";

/**
 * Earned auto-merge (§10.1, Integration step): whether a kind of work (docs, bug, feature)
 * has earned the right to merge automatically from its scorecard track record.
 * A kind may merge on its own only after its last N items in the scorecard passed first time
 * with no spot-check problems and no reverts.
 */

/**
 * Whether an item qualified as a clean first-pass merge in the scorecard:
 * it finished as merged, with 0 revise rounds (`attempts === 0`), was not reverted,
 * and had no spot-check problems.
 */
export function isCleanFirstPassMerge(item: FactoryItem): boolean {
  if (item.stage !== "merged" && item.mergedAt === null) return false;
  if (item.attempts !== 0) return false;
  if (revertedAt(item) !== null) return false;
  if (item.spotCheck?.state === "problem") return false;
  return true;
}

/**
 * Items that count in the scorecard (§10.1): work with a builder, excluding the factory's own
 * reverts and infrastructure failures.
 */
export function countsInScorecard(item: FactoryItem): boolean {
  if (item.source === "revert" || !item.builderProvider) return false;
  if (item.stage === "merged" || item.mergedAt !== null) return true;
  if (item.stage === "failed" && !isInfraFailure(item)) return true;
  return false;
}

/**
 * Finished scorecard items of `kind`, newest first.
 */
export function finishedScorecardItems(kind: WorkType, items: FactoryItem[]): FactoryItem[] {
  return items
    .filter((i) => i.type === kind && countsInScorecard(i))
    .sort((a, b) => {
      const timeA = Date.parse(a.mergedAt ?? a.finishedAt ?? a.updatedAt);
      const timeB = Date.parse(b.mergedAt ?? b.finishedAt ?? b.updatedAt);
      return timeB - timeA;
    });
}

/**
 * The current earned streak status for a kind of work over the project's items.
 */
export function earnedAutoMergeStatus(
  kind: WorkType,
  items: FactoryItem[],
  streak = 5,
): { earned: boolean; count: number; required: number } {
  const finished = finishedScorecardItems(kind, items);
  let count = 0;
  for (const item of finished) {
    if (isCleanFirstPassMerge(item)) {
      count++;
      if (count >= streak) break;
    } else {
      break;
    }
  }
  return {
    earned: count >= streak,
    count,
    required: streak,
  };
}

/**
 * Whether a kind of work (docs, bug, feature) has earned auto-merge from the scorecard:
 * its last N items in the scorecard passed first time with no spot-check problems and no reverts.
 */
export function hasEarnedAutoMerge(kind: WorkType, items: FactoryItem[], streak = 5): boolean {
  return earnedAutoMergeStatus(kind, items, streak).earned;
}
