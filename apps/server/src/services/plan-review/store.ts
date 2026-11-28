import type { PlanReview } from "@codeden/contracts";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { projectPlanReviews } from "../../db/schema-plan-reviews";
import type { EventStore } from "../../events/store";

/**
 * Plan reviews (§8.5) over the event log: reads come from the `project_plan_reviews` projection,
 * writes append `project.plan_review.updated` events.
 */
export class PlanReviewStore {
  constructor(
    private readonly db: Db,
    private readonly events: EventStore,
  ) {}

  /** The project's newest review, or undefined. */
  latest(projectId: string): PlanReview | undefined {
    return this.db
      .select()
      .from(projectPlanReviews)
      .where(eq(projectPlanReviews.projectId, projectId))
      .orderBy(desc(projectPlanReviews.createdAt), desc(projectPlanReviews.id))
      .limit(1)
      .get()?.review;
  }

  get(id: string): PlanReview | undefined {
    return this.db.select().from(projectPlanReviews).where(eq(projectPlanReviews.id, id)).get()
      ?.review;
  }

  /** Reviews still being worked on (reviewers at work, or the Planner settling), oldest first. */
  open(): PlanReview[] {
    return this.db
      .select()
      .from(projectPlanReviews)
      .all()
      .map((r) => r.review)
      .filter((r) => r.status === "reviewing" || r.status === "settling")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Record a new review or a change to one (an upsert). */
  save(review: PlanReview): PlanReview {
    const next = { ...review, updatedAt: new Date().toISOString() };
    this.events.append([
      { type: "project.plan_review.updated", sessionId: null, payload: { review: next } },
    ]);
    return next;
  }
}
