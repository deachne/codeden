import { z } from "zod";
import { Id, ProviderId, Timestamp } from "./common";

/**
 * Second opinions on a plan (§8.5). Next to **Approve plan**, an optional **Get second opinions**
 * button asks other models to review the plan on their own and read-only; the Planner then
 * checks each point against the real code and settles it in a table the owner accepts or
 * rejects row by row. It is never required and never automatic: nothing starts until the owner
 * presses **Go**, and Approve plan works as it always did.
 */

/** Work key prefix of a plan-review session: `plan-review:<review id>:<n>` for a reviewer. */
export const PLAN_REVIEW_WORK_KEY_PREFIX = "plan-review:";

/** Reviewers a review starts with unless the owner unticks some (§8.5). */
export const DEFAULT_PLAN_REVIEWERS = 3;
/** The most reviewers one review can have. */
export const MAX_PLAN_REVIEWERS = 5;
/** The most rows the Planner can settle in one table. */
export const MAX_PLAN_REVIEW_ROWS = 40;

/** How a reviewer's run stands. `stopped_cap`: it ran over the cost cap and was stopped. */
export const PlanReviewerStatus = z.enum(["running", "done", "stopped_cap", "failed"]);
export type PlanReviewerStatus = z.infer<typeof PlanReviewerStatus>;

/**
 * Where a review stands: `reviewing` (reviewers at work), `settling` (the Planner is checking
 * their points), `ready` (the table waits for the owner), `applied` (the accepted rows were sent
 * to the Planner to fold into the plan) or `cancelled`.
 */
export const PlanReviewStatus = z.enum(["reviewing", "settling", "ready", "applied", "cancelled"]);
export type PlanReviewStatus = z.infer<typeof PlanReviewStatus>;

/** One reviewer of a plan: a read-only agent session on its own, never shown the others' answers. */
export const PlanReviewer = z.object({
  sessionId: Id,
  providerId: ProviderId,
  /** The provider's name for people ("Codex"). */
  displayName: z.string(),
  status: PlanReviewerStatus,
  /** What it handed over with `submit_plan_review`; null until it does. */
  text: z.string().nullable(),
  /** What it cost so far, from the usage ledger (USD). */
  costUsd: z.number().nonnegative().default(0),
});
export type PlanReviewer = z.infer<typeof PlanReviewer>;

/** The owner's say on a row. */
export const PlanReviewDecision = z.enum(["pending", "accepted", "rejected"]);
export type PlanReviewDecision = z.infer<typeof PlanReviewDecision>;

/** What the Planner settles in one row (`submit_plan_opinions`). */
export const PlanOpinionRow = z.object({
  /** The point, in plain words. */
  point: z.string().trim().min(1).max(600),
  /** Who raised it: reviewer names, or "Planner". */
  raisedBy: z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(MAX_PLAN_REVIEWERS + 1),
  /** Whether the Planner agrees with the point after checking it against the code. */
  stance: z.enum(["agree", "disagree"]),
  /** What the Planner would do about it, in one short sentence. */
  call: z.string().trim().min(1).max(600),
  /** One line why. */
  reason: z.string().trim().min(1).max(600),
  /** True when only the owner can decide it ("ask Darcy"): reviewers can't ask him questions. */
  askOwner: z.boolean().default(false),
});
export type PlanOpinionRow = z.infer<typeof PlanOpinionRow>;

/** A row of the table, with the owner's decision. */
export const PlanReviewRow = PlanOpinionRow.extend({
  id: Id,
  decision: PlanReviewDecision.default("pending"),
});
export type PlanReviewRow = z.infer<typeof PlanReviewRow>;

/** One round of second opinions on a project's plan. */
export const PlanReview = z.object({
  id: Id,
  projectId: Id,
  status: PlanReviewStatus,
  /** SHA-256 of the plan the reviewers read. */
  planSha256: z.string().nullable(),
  /** The most one reviewer may cost (USD); a reviewer that goes over is stopped. */
  capUsd: z.number().positive(),
  reviewers: z.array(PlanReviewer),
  /** The Planner session that settles the table. */
  settlerSessionId: Id,
  rows: z.array(PlanReviewRow).default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type PlanReview = z.infer<typeof PlanReview>;

/** A reviewer the owner can tick in the box before Go. */
export const PlanReviewCandidate = z.object({
  providerId: ProviderId,
  displayName: z.string(),
  /** The model it would use; null: the provider's default. */
  model: z.string().nullable(),
  /** The company behind it, when the provider says. */
  maker: z.string().nullable(),
  /** False while it can't take new work (not installed, signed out, at a limit). */
  ready: z.boolean(),
  /** Why it isn't ready, in plain words; null when it is. */
  reason: z.string().nullable(),
  /** From a different company than the Planner's provider. */
  differentMaker: z.boolean(),
  /** Ticked when the box opens (up to `DEFAULT_PLAN_REVIEWERS`). */
  defaultOn: z.boolean(),
  /** A rough cost of its review (USD). */
  roughUsd: z.number().nonnegative(),
});
export type PlanReviewCandidate = z.infer<typeof PlanReviewCandidate>;

/** `GET /api/projects/:id/plan-review/options`: what the box before Go shows. */
export const PlanReviewOptions = z.object({
  candidates: z.array(PlanReviewCandidate),
  /** A rough cost of the Planner settling the table (USD). */
  settlerUsd: z.number().nonnegative(),
  /** The cost cap offered for each reviewer (USD). */
  defaultCapUsd: z.number().positive(),
});
export type PlanReviewOptions = z.infer<typeof PlanReviewOptions>;

/** `GET /api/projects/:id/plan-review`: the latest review of the project, or none. */
export const PlanReviewResponse = z.object({ review: PlanReview.nullable() });
export type PlanReviewResponse = z.infer<typeof PlanReviewResponse>;

/** `POST /api/projects/:id/plan-review` ("Go"): the only thing that starts any reviewer. */
export const StartPlanReviewRequest = z.object({
  reviewers: z.array(ProviderId).min(1).max(MAX_PLAN_REVIEWERS),
  capUsd: z.number().positive().max(1000),
});
export type StartPlanReviewRequest = z.infer<typeof StartPlanReviewRequest>;

/** `POST /api/projects/:id/plan-review/rows/:rowId`: the owner's Accept or Reject. */
export const DecidePlanReviewRowRequest = z.object({ decision: PlanReviewDecision });
export type DecidePlanReviewRowRequest = z.infer<typeof DecidePlanReviewRowRequest>;

/** `submit_plan_review`, a reviewer's report: plain words, findings most important first. */
export const SubmitPlanReviewInput = z.object({ text: z.string().trim().min(1).max(30_000) });
export type SubmitPlanReviewInput = z.infer<typeof SubmitPlanReviewInput>;

/** `submit_plan_opinions`, the Planner's settled table. */
export const SubmitPlanOpinionsInput = z.object({
  rows: z.array(PlanOpinionRow).min(1).max(MAX_PLAN_REVIEW_ROWS),
});
export type SubmitPlanOpinionsInput = z.infer<typeof SubmitPlanOpinionsInput>;

/** Payload of the persisted plan-review event (projected into `project_plan_reviews`). */
export const PLAN_REVIEW_EVENT_PAYLOADS = {
  /** A review started, a reviewer changed, the table arrived or a row was decided; an upsert. */
  "project.plan_review.updated": z.object({ review: PlanReview }),
} as const;
