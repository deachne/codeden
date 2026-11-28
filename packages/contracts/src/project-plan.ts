import { z } from "zod";
import { GitHubPrRef, Id } from "./common";
import { MAX_OWNER_CHECKS, OWNER_CHECK_MAX } from "./factory-owner-checks";

/**
 * The project plan (§8.5): `.codeden/PLAN.md`, beside the vision. The vision says why the project
 * exists and what's out of bounds; the plan says what gets built first and how (the first version,
 * the technical route, what waits, the questions still open). How the owner checks it works isn't
 * in it: that goes in owner checks (§10.1), which builders never see. It isn't a task list: progress lives in GitHub issues. Like everything under `.codeden/`, it is
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

/**
 * The project's feature map (§8.5): `.codeden/FEATURE_MAP.md`, beside the vision and the plan. A
 * plain list of every screen and button a person can reach, in the owner's words, with what isn't
 * built yet marked "(planned)", so people and agents name the same places. The Planner writes it
 * with the owner and keeps it current; owner checks use its names. Unlike owner checks, builders
 * may see it: it only names the places in the app. Always a protected area, like the rest of
 * `.codeden/`. Briefs carry it, cut to `FEATURE_MAP_BRIEF_MAX` characters.
 */
export const FEATURE_MAP_PATH = ".codeden/FEATURE_MAP.md";

/** The most of the feature map a brief carries; a longer map is cut and points to the file. */
export const FEATURE_MAP_BRIEF_MAX = 4000;

/** `GET /api/projects/:id/feature-map`: the map, or the template with `exists: false`. */
export const FeatureMapResponse = z.object({
  path: z.string(),
  exists: z.boolean(),
  contents: z.string(),
  /** After a save in a GitHub project: the pull request (`codeden/feature-map`) that commits it. */
  pr: GitHubPrRef.nullable().optional(),
  /** Why the map could not be committed to GitHub (it is still saved locally). */
  shareError: z.string().nullable().optional(),
});
export type FeatureMapResponse = z.infer<typeof FeatureMapResponse>;

/** `PUT /api/projects/:id/feature-map`. */
export const PutFeatureMapRequest = z.object({ contents: z.string().min(1).max(100_000) });
export type PutFeatureMapRequest = z.infer<typeof PutFeatureMapRequest>;

/**
 * Work key of a project's Planner session (§8.5): an agent session a person starts with "Plan with
 * me". It grills the owner one question at a time, then hands the vision and the plan over with
 * `propose_plan`, a tool only a person's own Planner session sees.
 */
export const PLANNER_WORK_KEY = "planner:plan";

/** Id of a project's "Plan this project?" Inbox card (§8.5, `plan_project`). */
export const planProjectInboxId = (projectId: string) => `inbox:plan-project:${projectId}`;

/**
 * The words of a project's "Plan this project?" card: while it is being planned, and once the
 * Planner handed over a vision and a plan for the owner to check.
 */
export function planProjectCard(name: string, waiting: boolean): { title: string; body: string } {
  return waiting
    ? {
        title: `A plan for ${name} is ready for you to check`,
        body: "Read the vision, the plan and the owner checks on the project page, then press Approve plan. Agents start building once you do.",
      }
    : {
        title: `Plan ${name} before agents build`,
        body: "Press Plan with me: the Planner looks at what's there, asks you one question at a time, then writes the vision, the plan and your owner checks. Until you approve the plan, the PM, automations and the factory don't start work in this project.",
      };
}

/** `POST /api/projects/:id/planner`: the project's Planner session, new or the one already open. */
export const StartPlannerResponse = z.object({
  sessionId: Id,
  /** `existing`: the project already had a Planner session that isn't archived; it is reused. */
  status: z.enum(["started", "queued", "existing"]),
});
export type StartPlannerResponse = z.infer<typeof StartPlannerResponse>;

/**
 * `propose_plan`, the Planner's hand-off: the full text of both files, and the owner's checks.
 * CodeDen saves the files (and the feature map, when given) as the Vision and Plan pages do (a pull request each in a GitHub
 * project), adds the checks the project doesn't have yet to its owner checks, and a project still
 * being planned moves to `awaiting_approval`. Only the owner approves.
 */
export const ProposePlanInput = z.object({
  vision: z.string().min(1).max(200_000),
  plan: z.string().min(1).max(100_000),
  /**
   * The feature map's full text (§8.5). Optional: leaving it out keeps the project's current map.
   */
  featureMap: z.string().min(1).max(100_000).optional(),
  /**
   * How the owner will check it works, one short scenario each in their own words. Kept out of
   * the files on purpose: owner checks live in CodeDen's data, so builders never see them.
   */
  ownerChecks: z
    .array(z.string().trim().min(1).max(OWNER_CHECK_MAX))
    .max(MAX_OWNER_CHECKS)
    .default([]),
});
export type ProposePlanInput = z.infer<typeof ProposePlanInput>;
