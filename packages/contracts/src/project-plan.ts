import { z } from "zod";
import { GitHubPrRef } from "./common";

/**
 * The project plan (§8.5): `.codeden/PLAN.md`, beside the vision. The vision says why the project
 * exists and what's out of bounds; the plan says what gets built first and how (the first version,
 * the technical route, what waits, how the owner checks it works, the questions still open).
 * It isn't a task list: progress lives in GitHub issues. Like everything under `.codeden/`, it is
 * always a protected area, so no agent change to it merges by itself. CodeDen adds it, cut to
 * `PLAN_BRIEF_MAX` characters, to the briefs of factory builders, reviewers and the scout, and of
 * the sessions a PM starts.
 */
export const PLAN_PATH = ".codeden/PLAN.md";

/** The most of the plan a brief carries; a longer plan is cut and points to the file. */
export const PLAN_BRIEF_MAX = 6000;

/** `GET /api/projects/:id/plan`: the plan, or the template with `exists: false`. */
export const PlanResponse = z.object({
  path: z.string(),
  exists: z.boolean(),
  contents: z.string(),
  /**
   * After a save in a GitHub project: the pull request (`codeden/plan`) that commits the plan,
   * so agents' worktrees (cut from the default branch) get it once it merges.
   */
  pr: GitHubPrRef.nullable().optional(),
  /** Why the plan could not be committed to GitHub (it is still saved locally). */
  shareError: z.string().nullable().optional(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

/** `PUT /api/projects/:id/plan`. */
export const PutPlanRequest = z.object({ contents: z.string().min(1).max(100_000) });
export type PutPlanRequest = z.infer<typeof PutPlanRequest>;
