import type { EventOf } from "@codeden/contracts";
import { projectPlanReviews } from "../../db/schema-plan-reviews";
import type { Tx } from "../../events/projection-db";

/** Project a plan review (§8.5) inside the append transaction, so it can be rebuilt from the log. */
export function applyPlanReviewProjection(tx: Tx, e: EventOf<"project.plan_review.updated">): void {
  const { review } = e.payload;
  const row = {
    id: review.id,
    projectId: review.projectId,
    review,
    createdAt: review.createdAt,
  };
  tx.insert(projectPlanReviews)
    .values(row)
    .onConflictDoUpdate({ target: projectPlanReviews.id, set: row })
    .run();
}
