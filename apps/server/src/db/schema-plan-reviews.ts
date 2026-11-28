import type { PlanReview } from "@codeden/contracts";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Second opinions on a plan (§8.5), one row per review, from `project.plan_review.updated`
 * (an upsert), written in the same transaction as the event so it can be rebuilt from the log.
 */
export const projectPlanReviews = sqliteTable(
  "project_plan_reviews",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    review: text("review", { mode: "json" }).$type<PlanReview>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("project_plan_reviews_project").on(t.projectId, t.createdAt)],
);
